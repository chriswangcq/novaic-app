"""
NovAIC Configuration
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Server settings"""
    
    # Server - 绑定到所有地址，但通过 QEMU 端口转发只暴露到宿主机 127.0.0.1
    # 安全性：VM 使用 user networking，没有外部网络接口
    host: str = "0.0.0.0"
    port: int = 8080
    
    # Work directory
    work_dir: str = "/tmp/novaic-work"
    
    # Browser settings
    browser_headless: bool = False
    browser_timeout: int = 30000  # ms
    browser_user_data_dir: str = "/home/ubuntu/.config/chromium"  # Share with system chromium
    
    # Execution settings
    default_timeout: int = 60  # seconds
    
    class Config:
        env_prefix = "NOVAIC_"


settings = Settings()

