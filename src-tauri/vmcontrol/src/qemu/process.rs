pub struct QemuProcess {
    pub id: String,
    // TODO: Add child process handle
}

impl QemuProcess {
    pub fn new(id: String) -> Self {
        Self { id }
    }
}
