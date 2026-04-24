pub mod embedding;

use std::path::Path;

use anyhow::Result;

pub fn create_session<P: AsRef<Path>>(path: P) -> Result<ort::session::Session> {
    let session = ort::session::Session::builder()?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
        .with_intra_threads(1)?
        .with_inter_threads(1)?
        .commit_from_file(path.as_ref())?;
    Ok(session)
}
pub mod embedding_manager;
pub mod models;
mod prepare_segments;
pub use prepare_segments::prepare_segments;
pub mod segment;
