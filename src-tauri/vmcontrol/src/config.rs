use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub runtime_dir: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            runtime_dir: std::env::temp_dir().join("novaic"),
        }
    }
}
