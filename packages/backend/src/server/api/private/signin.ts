import Koa from 'koa';
import bcrypt from 'bcryptjs';
import * as speakeasy from 'speakeasy';
import signin from '../common/signin.js';
import config from '@/config/index.js';
import { Users, Signins, UserProfiles, UserSecurityKeys, AttestationChallenges } from '@/models/index.js';
import { ILocalUser } from '@/models/entities/user.js';
import { genId } from '@/misc/gen-id.js';
import { verifyLogin, hash } from '../2fa.js';
import { randomBytes } from 'node:crypto';
import { IsNull } from 'typeorm';
import { limiter } from '../limiter.js';
import { getIpHash } from '@/misc/get-ip-hash.js';
import { ApiError } from '../error.js';

export default async (ctx: Koa.Context) => {
	ctx.set('Access-Control-Allow-Origin', config.url);
	ctx.set('Access-Control-Allow-Credentials', 'true');

	const body = ctx.request.body as any;
	const { username, password, token } = body;

	// taken from @server/api/api-handler.ts
	function error (e: ApiError): void {
		ctx.status = e.httpStatusCode;
		if (e.httpStatusCode === 401) {
			ctx.response.set('WWW-Authenticate', 'Bearer');
		}
		ctx.body = {
			error: {
				message: e!.message,
				code: e!.code,
				...(e!.info ? { info: e!.info } : {}),
				endpoint: endpoint.name,
			},
		};
	}

	try {
		// not more than 1 attempt per second and not more than 10 attempts per hour
		await limiter({ key: 'signin', duration: 60 * 60 * 1000, max: 10, minInterval: 1000 }, getIpHash(ctx.ip));
	} catch (err) {
		error(new ApiError('RATE_LIMIT_EXCEEDED'));
		return;
	}

	if (typeof username !== 'string') {
		error(new ApiError('INVALID_PARAM', { param: 'username', reason: 'not a string' }));
		return;
	}

	if (typeof password !== 'string') {
		error(new ApiError('INVALID_PARAM', { param: 'password', reason: 'not a string' }));
		return;
	}

	if (token != null && typeof token !== 'string') {
		error(new ApiError('INVALID_PARAM', { param: 'token', reason: 'provided but not a string' }));
		return;
	}

	// Fetch user
	const user = await Users.findOneBy({
		usernameLower: username.toLowerCase(),
		host: IsNull(),
	}) as ILocalUser;

	if (user == null) {
		error(new ApiError('NO_SUCH_USER'));
		return;
	}

	if (user.isSuspended) {
		error(new ApiError('SUSPENDED'));
		return;
	}

	const profile = await UserProfiles.findOneByOrFail({ userId: user.id });

	// Compare password
	const same = await bcrypt.compare(password, profile.password!);

	async function fail(): void {
		// Append signin history
		await Signins.insert({
			id: genId(),
			createdAt: new Date(),
			userId: user.id,
			ip: ctx.ip,
			headers: ctx.headers,
			success: false,
		});

		error(new ApiError('ACCESS_DENIED'));
	}

	if (!profile.twoFactorEnabled) {
		if (same) {
			signin(ctx, user);
			return;
		} else {
			await fail();
			return;
		}
	}

	if (token) {
		if (!same) {
			await fail();
			return;
		}

		const verified = (speakeasy as any).totp.verify({
			secret: profile.twoFactorSecret,
			encoding: 'base32',
			token: token,
			window: 2,
		});

		if (verified) {
			signin(ctx, user);
			return;
		} else {
			await fail();
			return;
		}
	} else if (body.credentialId) {
		if (!same && !profile.usePasswordLessLogin) {
			await fail();
			return;
		}

		const clientDataJSON = Buffer.from(body.clientDataJSON, 'hex');
		const clientData = JSON.parse(clientDataJSON.toString('utf-8'));
		const challenge = await AttestationChallenges.findOneBy({
			userId: user.id,
			id: body.challengeId,
			registrationChallenge: false,
			challenge: hash(clientData.challenge).toString('hex'),
		});

		if (!challenge) {
			await fail();
			return;
		}

		await AttestationChallenges.delete({
			userId: user.id,
			id: body.challengeId,
		});

		if (new Date().getTime() - challenge.createdAt.getTime() >= 5 * 60 * 1000) {
			await fail();
			return;
		}

		const securityKey = await UserSecurityKeys.findOneBy({
			id: Buffer.from(
				body.credentialId
					.replace(/-/g, '+')
					.replace(/_/g, '/'),
				'base64',
			).toString('hex'),
		});

		if (!securityKey) {
			await fail();
			return;
		}

		const isValid = verifyLogin({
			publicKey: Buffer.from(securityKey.publicKey, 'hex'),
			authenticatorData: Buffer.from(body.authenticatorData, 'hex'),
			clientDataJSON,
			clientData,
			signature: Buffer.from(body.signature, 'hex'),
			challenge: challenge.challenge,
		});

		if (isValid) {
			signin(ctx, user);
			return;
		} else {
			await fail();
			return;
		}
	} else {
		if (!same && !profile.usePasswordLessLogin) {
			await fail();
			return;
		}

		const keys = await UserSecurityKeys.findBy({
			userId: user.id,
		});

		if (keys.length === 0) {
			await fail();
			return;
		}

		// 32 byte challenge
		const challenge = randomBytes(32).toString('base64')
			.replace(/=/g, '')
			.replace(/\+/g, '-')
			.replace(/\//g, '_');

		const challengeId = genId();

		await AttestationChallenges.insert({
			userId: user.id,
			id: challengeId,
			challenge: hash(Buffer.from(challenge, 'utf-8')).toString('hex'),
			createdAt: new Date(),
			registrationChallenge: false,
		});

		ctx.body = {
			challenge,
			challengeId,
			securityKeys: keys.map(key => ({
				id: key.id,
			})),
		};
		ctx.status = 200;
		return;
	}
	// never get here
};
