use std::error;

use axum::Router;

use tokio::runtime;

use config::get_config;

pub mod api {
    pub mod routes;
}

pub enum Error {}

pub fn init() -> Result<(), Box<dyn error::Error>> {
    // initialize tokio runtime
    let mut rt = runtime::Builder::new_multi_thread();

    let rt = rt.enable_all();

    if let Some(n) = get_config()?.cluster_limit {
        rt.worker_threads(n as usize);
    }

    let rt = rt.build()?;

    let app = Router::new().nest("/api", api::routes::routes());

    rt.block_on(async {
        axum::Server::bind(&format!("127.0.0.1:{}", get_config()?.port).parse()?)
            .serve(app.into_make_service())
            .await?;
        Result::<(), Box<dyn error::Error>>::Ok(())
    })?;

    Ok(())
}
