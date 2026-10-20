#![cfg(not(test))]

use std::sync::Arc;

use ark_testing::{btc, control_server, TestContext};

#[tokio::main]
async fn main() {
	let ctx = Arc::new(TestContext::new("regtest-env").await);
	let srv = ctx.captaind("server").funded(btc(10)).create().await;
	let server_url = srv.ark_url().replace("0.0.0.0", "127.0.0.1");

	let control = control_server::ControlServer::new(ctx.clone(), srv);
	let control_url = control.url();
	let esplora_url = format!("{}/esplora", control_url);
	control.spawn();

	println!("ARK_SERVER_URL={}", server_url);
	println!("ARK_CONTROL_URL={}", control_url);
	println!("ARK_ESPLORA_URL={}", esplora_url);
	println!("READY");

	tokio::signal::ctrl_c().await.ok();
}
