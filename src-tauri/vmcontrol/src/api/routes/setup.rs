//! VM Setup — creates disk image and cloud-init ISO locally.
//! Called by the Gateway via CloudBridge so that qemu-img/hdiutil run on the Mac.

use axum::{Json, extract::Path, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Deserialize)]
pub struct SetupVmRequest {
    /// Absolute path to the base cloud image (e.g. .qcow2 or .img)
    pub source_image: String,
    /// SSH public key injected via cloud-init
    pub ssh_pubkey: String,
    #[serde(default)]
    pub use_cn_mirrors: bool,
    #[serde(default = "default_disk_size")]
    pub disk_size: String,
    /// Ignored — data_path is always derived locally from NOVAIC_DATA_DIR
    #[serde(default)]
    pub data_path: Option<String>,
}

fn default_disk_size() -> String { "40G".to_string() }

fn local_data_path(vm_id: &str) -> PathBuf {
    let data_dir = std::env::var("NOVAIC_DATA_DIR").ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join("Library/Application Support/com.novaic.app")
        });
    data_dir.join("devices").join(vm_id)
}

#[derive(Debug, Serialize)]
pub struct SetupVmResponse {
    pub status: String,
    pub disk_path: String,
    pub cloudinit_iso: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uefi_vars: Option<String>,
}

fn api_err(msg: String) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": msg })))
}

pub async fn setup_vm(
    Path(_vm_id): Path<String>,
    Json(req): Json<SetupVmRequest>,
) -> Result<Json<SetupVmResponse>, (StatusCode, Json<serde_json::Value>)> {
    let data_path = local_data_path(&_vm_id);
    tracing::info!("[setup_vm] vm_id={} source={} data_path={}", _vm_id, req.source_image, data_path.display());

    std::fs::create_dir_all(&data_path)
        .map_err(|e| api_err(format!("create data_path {}: {e}", data_path.display())))?;

    // ── 1. Find qemu-img ──────────────────────────────────────────────────────
    let resource_dir = std::env::var("NOVAIC_RESOURCE_DIR").unwrap_or_default();
    let qemu_img = find_qemu_img(&resource_dir)
        .ok_or_else(|| api_err("qemu-img not found".to_string()))?;

    // ── 2. Create disk ────────────────────────────────────────────────────────
    let disk_path = data_path.join("disk.qcow2");
    if !disk_path.exists() {
        let out = Command::new(&qemu_img)
            .args(["convert", "-O", "qcow2", &req.source_image,
                   disk_path.to_str().unwrap()])
            .output()
            .map_err(|e| api_err(format!("qemu-img convert: {e}")))?;
        if !out.status.success() {
            return Err(api_err(format!("qemu-img convert failed: {}",
                String::from_utf8_lossy(&out.stderr))));
        }
        let out = Command::new(&qemu_img)
            .args(["resize", disk_path.to_str().unwrap(), &req.disk_size])
            .output()
            .map_err(|e| api_err(format!("qemu-img resize: {e}")))?;
        if !out.status.success() {
            return Err(api_err(format!("qemu-img resize failed: {}",
                String::from_utf8_lossy(&out.stderr))));
        }
        tracing::info!("[setup_vm] disk created: {}", disk_path.display());
    }

    // ── 3. Cloud-init ISO ─────────────────────────────────────────────────────
    let cloudinit_iso = data_path.join("cloud-init.iso");
    if !cloudinit_iso.exists() {
        create_cloud_init_iso(&data_path, &cloudinit_iso, &req.ssh_pubkey, req.use_cn_mirrors)
            .map_err(|e| api_err(e))?;
        tracing::info!("[setup_vm] cloud-init ISO: {}", cloudinit_iso.display());
    }

    // ── 4. UEFI firmware (ARM64 only) ─────────────────────────────────────────
    let uefi_vars = if std::env::consts::ARCH == "aarch64" {
        Some(setup_uefi(&data_path, &resource_dir)
            .map_err(|e| api_err(e))?)
    } else { None };

    Ok(Json(SetupVmResponse {
        status: "ok".to_string(),
        disk_path: disk_path.to_string_lossy().to_string(),
        cloudinit_iso: cloudinit_iso.to_string_lossy().to_string(),
        uefi_vars,
    }))
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn find_qemu_img(resource_dir: &str) -> Option<String> {
    let candidates = vec![
        if !resource_dir.is_empty() {
            Some(format!("{}/qemu/qemu-img", resource_dir))
        } else { None },
        Some("/opt/homebrew/bin/qemu-img".to_string()),
        Some("/usr/local/bin/qemu-img".to_string()),
        Some("qemu-img".to_string()),
    ];
    candidates.into_iter().flatten().find(|p| {
        if p == "qemu-img" { std::process::Command::new(p).arg("--version").output().is_ok() }
        else { std::path::Path::new(p).exists() }
    })
}

fn create_cloud_init_iso(
    data_path: &PathBuf,
    iso_path: &PathBuf,
    ssh_pubkey: &str,
    use_cn_mirrors: bool,
) -> Result<(), String> {
    let ci_dir = data_path.join("cloud-init");
    std::fs::create_dir_all(&ci_dir)
        .map_err(|e| format!("mkdir cloud-init: {e}"))?;

    // meta-data
    std::fs::write(ci_dir.join("meta-data"),
        "instance-id: novaic-vm\nlocal-hostname: novaic-vm\n")
        .map_err(|e| format!("write meta-data: {e}"))?;

    // user-data
    let user_data = generate_user_data(ssh_pubkey, use_cn_mirrors);
    std::fs::write(ci_dir.join("user-data"), &user_data)
        .map_err(|e| format!("write user-data: {e}"))?;

    // ISO creation (macOS: hdiutil; Linux: genisoimage/mkisofs)
    #[cfg(target_os = "macos")]
    {
        // hdiutil needs files in a temp dir
        let tmp_dir = data_path.join("cloud-init-tmp");
        std::fs::create_dir_all(&tmp_dir).ok();
        std::fs::copy(ci_dir.join("user-data"), tmp_dir.join("user-data"))
            .map_err(|e| format!("copy user-data: {e}"))?;
        std::fs::copy(ci_dir.join("meta-data"), tmp_dir.join("meta-data"))
            .map_err(|e| format!("copy meta-data: {e}"))?;

        // hdiutil outputs <base>.iso, strip .iso suffix for -o arg
        let iso_base = iso_path.with_extension("");
        let out = Command::new("/usr/bin/hdiutil")
            .args(["makehybrid", "-o", iso_base.to_str().unwrap(),
                   "-hfs", "-joliet", "-iso",
                   "-default-volume-name", "cidata",
                   tmp_dir.to_str().unwrap()])
            .output()
            .map_err(|e| format!("hdiutil: {e}"))?;
        std::fs::remove_dir_all(&tmp_dir).ok();
        if !out.status.success() {
            return Err(format!("hdiutil failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
        // hdiutil adds .iso even when we strip it
        let created = iso_base.with_extension("iso");
        if created != *iso_path && created.exists() {
            std::fs::rename(&created, iso_path)
                .map_err(|e| format!("rename iso: {e}"))?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let tool = ["genisoimage", "mkisofs"].iter().find(|t| {
            Command::new(t).arg("--version").output().is_ok()
        }).copied().ok_or("genisoimage/mkisofs not found")?;

        let out = Command::new(tool)
            .args(["-output", iso_path.to_str().unwrap(),
                   "-volid", "cidata", "-joliet", "-rock",
                   ci_dir.join("user-data").to_str().unwrap(),
                   ci_dir.join("meta-data").to_str().unwrap()])
            .output()
            .map_err(|e| format!("{tool}: {e}"))?;
        if !out.status.success() {
            return Err(format!("{tool} failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }

    Ok(())
}

fn setup_uefi(data_path: &PathBuf, resource_dir: &str) -> Result<String, String> {
    let firmware_candidates = vec![
        if !resource_dir.is_empty() {
            Some(format!("{}/qemu/QEMU_EFI.fd", resource_dir))
        } else { None },
        Some("/opt/homebrew/share/qemu/edk2-aarch64-code.fd".to_string()),
        Some("/usr/share/qemu-efi-aarch64/QEMU_EFI.fd".to_string()),
    ];
    let src = firmware_candidates.into_iter().flatten()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or("UEFI firmware not found")?;

    let dst_fw = data_path.join("QEMU_EFI.fd");
    if !dst_fw.exists() {
        std::fs::copy(&src, &dst_fw)
            .map_err(|e| format!("copy UEFI firmware: {e}"))?;
    }

    let vars_path = data_path.join("QEMU_VARS.fd");
    if !vars_path.exists() {
        let f = std::fs::File::create(&vars_path)
            .map_err(|e| format!("create VARS: {e}"))?;
        f.set_len(64 * 1024 * 1024)
            .map_err(|e| format!("truncate VARS: {e}"))?;
    }

    Ok(vars_path.to_string_lossy().to_string())
}

fn generate_user_data(ssh_pubkey: &str, use_cn_mirrors: bool) -> String {
    let arch = std::env::consts::ARCH;
    let is_arm = arch == "aarch64";

    let (apt_mirror, pip_mirror, pip_host, nodejs_setup_url, npm_registry, playwright_mirror) =
        if use_cn_mirrors {
            let apt = if is_arm { "mirrors.aliyun.com/ubuntu-ports" } else { "mirrors.aliyun.com/ubuntu" };
            (apt,
             "mirrors.aliyun.com/pypi/simple/",
             "mirrors.aliyun.com",
             "https://mirrors.aliyun.com/nodesource/setup_20.x",
             "https://registry.npmmirror.com",
             "https://npmmirror.com/mirrors/playwright/")
        } else {
            let apt = if is_arm { "ports.ubuntu.com/ubuntu-ports" } else { "archive.ubuntu.com/ubuntu" };
            (apt,
             "pypi.org/simple/",
             "pypi.org",
             "https://deb.nodesource.com/setup_20.x",
             "https://registry.npmjs.org",
             "")
        };

    format!(r#"#cloud-config

# bootcmd runs earliest — set up TTY1 autologin so cloud-init log is visible via VNC
bootcmd:
  - mkdir -p /etc/systemd/system/getty@tty1.service.d
  - |
    cat > /etc/systemd/system/getty@tty1.service.d/override.conf << 'EOFGETTY'
    [Service]
    ExecStart=
    ExecStart=-/sbin/agetty --autologin ubuntu --noclear %I $TERM
    EOFGETTY
  - systemctl daemon-reload
  - |
    (while ! id ubuntu >/dev/null 2>&1; do sleep 1; done; sleep 2; systemctl restart getty@tty1.service) &

users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    groups: [adm, audio, cdrom, dialout, dip, floppy, lxd, netdev, plugdev, sudo, video]
    ssh_authorized_keys:
      - {ssh_pubkey}

chpasswd:
  list: |
    ubuntu:ubuntu
  expire: false

ssh_pwauth: true

apt:
  primary:
    - arches: [default]
      uri: http://{apt_mirror}
  sources_list: |
    deb http://{apt_mirror} noble main restricted universe multiverse
    deb http://{apt_mirror} noble-updates main restricted universe multiverse
    deb http://{apt_mirror} noble-backports main restricted universe multiverse
    deb http://{apt_mirror} noble-security main restricted universe multiverse

package_update: true
package_upgrade: false

packages:
  - xserver-xorg
  - xserver-xorg-core
  - xserver-xorg-input-all
  - xserver-xorg-video-dummy
  - x11-utils
  - x11-xserver-utils
  - xfce4
  - xfce4-terminal
  - xfce4-goodies
  - lightdm
  - lightdm-gtk-greeter
  - dbus-x11
  - chromium-browser
  - xdotool
  - wmctrl
  - scrot
  - imagemagick
  - xclip
  - python3
  - python3-pip
  - python3-venv
  - curl
  - wget
  - net-tools
  - openssh-server
  - git
  - vim
  - htop
  - qemu-guest-agent
  - tigervnc-standalone-server

write_files:
  - path: /etc/X11/xorg.conf.d/10-novaic.conf
    content: |
      Section "Device"
        Identifier "VirtioGPU"
        Driver "modesetting"
        Option "AccelMethod" "glamor"
      EndSection
      Section "Screen"
        Identifier "DefaultScreen"
        Device "VirtioGPU"
        DefaultDepth 24
        SubSection "Display"
          Depth 24
          Modes "1280x720" "1024x768"
        EndSubSection
      EndSection
    permissions: '0644'

  - path: /etc/lightdm/lightdm.conf.d/50-autologin.conf
    content: |
      [Seat:*]
      autologin-user=ubuntu
      autologin-user-timeout=0
      autologin-session=xfce

  - path: /home/ubuntu/.bash_profile
    content: |
      # NovAIC: show cloud-init log on first boot until init completes
      if [ -f /var/log/cloud-init-output.log ] && [ ! -f /var/log/novaic-init-done.log ]; then
        echo ""
        echo "=========================================="
        echo "  NovAIC VM initializing..."
        echo "  Streaming cloud-init log"
        echo "=========================================="
        echo ""
        tail -f /var/log/cloud-init-output.log &
        TAIL_PID=$!
        while [ ! -f /var/log/novaic-init-done.log ]; do
          sleep 2
        done
        kill $TAIL_PID 2>/dev/null
        echo ""
        echo "=========================================="
        echo "  Init complete! Starting desktop..."
        echo "=========================================="
        sleep 2
      fi
    permissions: '0644'

  - path: /home/ubuntu/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-power-manager.xml
    content: |
      <?xml version="1.0" encoding="UTF-8"?>
      <channel name="xfce4-power-manager" version="1.0">
        <property name="xfce4-power-manager" type="empty">
          <property name="dpms-enabled" type="bool" value="false"/>
          <property name="blank-on-ac" type="int" value="0"/>
          <property name="dpms-on-ac-sleep" type="uint" value="0"/>
          <property name="dpms-on-ac-off" type="uint" value="0"/>
        </property>
      </channel>

  - path: /opt/novaic/start-tigervnc.sh
    content: |
      #!/bin/bash
      set -e
      # NovAIC main desktop session.
      # VNC is served by QEMU built-in VNC (-vnc unix:...) — this script only manages:
      #   1. chmod 9p share so sub-users can write TCP port files
      #   2. Start XFCE4 on the virtual display
      DISPLAY_NUM=10

      # Wait for 9p share (best-effort) then open it up for sub-user port files
      for i in $(seq 1 30); do
          mountpoint -q /mnt/novaic-share && break
          sleep 1
      done
      chmod 777 /mnt/novaic-share 2>/dev/null || true

      # Start XFCE4 on the QEMU virtual display with its own DBus session
      export DISPLAY=":$DISPLAY_NUM"
      export HOME=/home/ubuntu
      export USER=ubuntu
      export LOGNAME=ubuntu
      export SHELL=/bin/bash
      export XDG_RUNTIME_DIR=/tmp/runtime-ubuntu
      mkdir -p "$XDG_RUNTIME_DIR"
      chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true
      if command -v dbus-run-session >/dev/null 2>&1; then
          exec dbus-run-session -- startxfce4
      else
          exec dbus-launch --exit-with-session startxfce4
      fi
    permissions: '0755'
    owner: ubuntu:ubuntu

  - path: /etc/systemd/system/novaic-tigervnc.service
    content: |
      [Unit]
      Description=NovAIC desktop session (display :10)
      After=network.target

      [Service]
      Type=simple
      User=ubuntu
      ExecStart=/opt/novaic/start-tigervnc.sh
      Restart=on-failure
      RestartSec=10
      TimeoutStartSec=120
      StandardOutput=journal
      StandardError=journal
      SyslogIdentifier=novaic-tigervnc

      [Install]
      WantedBy=multi-user.target
    permissions: '0644'

  - path: /etc/systemd/system/novaic-vmuse.service
    content: |
      [Unit]
      Description=NovAIC VMUSE HTTP Server
      After=network.target novaic-tigervnc.service

      [Service]
      Type=simple
      User=ubuntu
      WorkingDirectory=/opt/novaic/novaic-mcp-vmuse
      Environment="DISPLAY=:10"
      Environment="PATH=/opt/novaic/venv/bin:/usr/local/bin:/usr/bin:/bin"
      Environment="PYTHONPATH=/opt/novaic/novaic-mcp-vmuse/src"
      ExecStart=/opt/novaic/venv/bin/python3 -m novaic_mcp_vmuse.http_server
      Restart=always
      RestartSec=10
      StandardOutput=journal
      StandardError=journal
      SyslogIdentifier=novaic-vmuse

      [Install]
      WantedBy=multi-user.target
    permissions: '0644'

  - path: /opt/novaic/scripts/playwright_helper.py
    content: |
      #!/usr/bin/env python3
      import sys, json
      from playwright.sync_api import sync_playwright
      DEFAULT_TIMEOUT = 30000
      def main():
          if len(sys.argv) < 2:
              print(json.dumps({{"status": "error", "error": "Missing command"}})); sys.exit(1)
          command = sys.argv[1]
          args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {{}}
          try:
              with sync_playwright() as p:
                  browser = p.chromium.launch(headless=False,
                      args=["--no-sandbox","--disable-setuid-sandbox"])
                  ctx  = browser.new_context(viewport={{"width":1280,"height":720}})
                  page = ctx.new_page()
                  page.set_default_timeout(DEFAULT_TIMEOUT)
                  result = {{}}
                  if command == "navigate":
                      r = page.goto(args.get("url",""), wait_until="domcontentloaded")
                      result = {{"status":"success","url":page.url,"title":page.title(),"status_code":r.status if r else 0}}
                  elif command == "click":
                      page.click(args.get("selector","")); result = {{"status":"success"}}
                  elif command == "type":
                      page.fill(args.get("selector",""), args.get("text","")); result = {{"status":"success"}}
                  elif command == "screenshot":
                      result = {{"status":"success","data":page.screenshot().hex()}}
                  elif command == "content":
                      result = {{"status":"success","html":page.content(),"url":page.url,"title":page.title()}}
                  else:
                      result = {{"status":"error","error":f"Unknown command: {{command}}"}}
                  browser.close()
                  print(json.dumps(result))
          except Exception as e:
              print(json.dumps({{"status":"error","error":str(e)}})); sys.exit(1)
      if __name__ == "__main__":
          main()
    permissions: '0755'

runcmd:
  # Phase 1 - Directory setup
  - echo "=== Phase 1 - Directory Setup ==="
  - mkdir -p /home/ubuntu/.config/xfce4/xfconf/xfce-perchannel-xml
  - mkdir -p /opt/novaic/scripts
  - mkdir -p /opt/novaic/venv
  - mkdir -p /opt/novaic/novaic-mcp-vmuse/src/novaic_mcp_vmuse
  - mkdir -p /opt/novaic/.cache
  - mkdir -p /mnt/novaic-share
  - modprobe 9pnet_virtio || true
  - mount -t 9p -o trans=virtio,version=9p2000.L novaic_share /mnt/novaic-share || echo "WARNING - 9p mount failed"
  - echo 'novaic_share /mnt/novaic-share 9p trans=virtio,version=9p2000.L,_netdev,nofail 0 0' >> /etc/fstab
  - chown -R ubuntu:ubuntu /home/ubuntu

  # Phase 2 - Network & environment
  - echo "=== Phase 2 - Network & Environment ==="
  - until ping -c 1 -W 3 8.8.8.8 > /dev/null 2>&1; do sleep 2; done
  - echo "Network ready."
  - echo 'DISPLAY=:0' | tee -a /etc/environment
  - echo 'export PATH="/opt/novaic/venv/bin:$PATH"' | tee /etc/profile.d/novaic.sh

  # Phase 3 - Node.js 20 LTS
  - echo "=== Phase 3 - Installing Node.js 20 LTS ==="
  - curl -fsSL {nodejs_setup_url} | bash -
  - apt-get install -y nodejs
  - node --version | tee /opt/novaic/.node_version
  - npm --version  | tee /opt/novaic/.npm_version
  - npm config set registry {npm_registry}

  # Phase 4 - Python venv
  - echo "=== Phase 4 - Python Virtual Environment ==="
  - python3 -m venv /opt/novaic/venv
  - /opt/novaic/venv/bin/pip install --upgrade pip --index-url https://{pip_mirror} --trusted-host {pip_host}

  # Phase 5 - VMUSE Python deps
  - echo "=== Phase 5 - VMUSE Python Dependencies ==="
  - /opt/novaic/venv/bin/pip install aiohttp pydantic pydantic-settings python-dotenv Pillow playwright --index-url https://{pip_mirror} --trusted-host {pip_host}

  # Phase 6 - Playwright + Chromium
  - echo "=== Phase 6 - Playwright Chromium ==="
  - |
    install_playwright() {{
      if [ -n "{playwright_mirror}" ]; then
        export PLAYWRIGHT_DOWNLOAD_HOST="{playwright_mirror}"
        if /opt/novaic/venv/bin/playwright install --with-deps chromium 2>&1; then
          echo "Playwright installed from mirror"; return 0
        fi
        unset PLAYWRIGHT_DOWNLOAD_HOST
      fi
      /opt/novaic/venv/bin/playwright install --with-deps chromium
    }}
    install_playwright

  # Phase 7 - QEMU Guest Agent
  - echo "=== Phase 7 - QEMU Guest Agent ==="
  - systemctl daemon-reload
  - systemctl enable qemu-guest-agent
  - systemctl start qemu-guest-agent

  # Phase 8 - Ownership
  - echo "=== Phase 8 - Ownership ==="
  - chown -R ubuntu:ubuntu /home/ubuntu
  - chown -R ubuntu:ubuntu /opt/novaic

  # Phase 9 - Display manager
  - echo "=== Phase 9 - Display Manager ==="
  - mkdir -p /tmp/.X11-unix
  - chmod 1777 /tmp/.X11-unix
  - chown root:root /tmp/.X11-unix
  - systemctl enable lightdm
  - systemctl start lightdm
  - sleep 15
  - echo "Verifying X server..."
  - pgrep -x Xorg || (echo "ERROR - X server not running" && exit 1)
  - DISPLAY=:0 xdpyinfo > /dev/null 2>&1 || (echo "ERROR - DISPLAY not available" && exit 1)
  - systemctl is-active lightdm || (echo "ERROR - lightdm not active" && exit 1)
  - pgrep -u ubuntu xfce4-session && echo "Desktop session running" || echo "WARNING - xfce4 not up yet"

  # Phase 10 - TigerVNC service
  - echo "=== Phase 10 - TigerVNC Service ==="
  - chmod +x /opt/novaic/start-tigervnc.sh
  - chown ubuntu:ubuntu /opt/novaic/start-tigervnc.sh
  - systemctl daemon-reload
  - systemctl enable novaic-tigervnc
  - systemctl start novaic-tigervnc
  - sleep 5
  - systemctl is-active novaic-tigervnc && echo "TigerVNC started" || echo "WARNING - TigerVNC not active yet (will retry)"

  # Phase 11 - VMUSE service
  - echo "=== Phase 11 - VMUSE Service ==="
  - systemctl daemon-reload
  - systemctl enable novaic-vmuse

  # Phase 13 - Done
  - touch /opt/novaic/.dependencies_installed
  - touch /opt/novaic/.cloud_init_complete
  - echo "NovAIC VM cloud-init completed at $(date)" | tee /var/log/novaic-init-done.log
  - echo "=== Cloud-Init Complete ==="

final_message: |
  =====================================================
  NovAIC VM configuration complete!
  =====================================================
  VM internal ports (mapped to dynamic host ports via QEMU):
  - SSH: 22
  Check NovAIC app for actual host port mappings.
"#,
        ssh_pubkey = ssh_pubkey,
        apt_mirror = apt_mirror,
        pip_mirror = pip_mirror,
        pip_host = pip_host,
        nodejs_setup_url = nodejs_setup_url,
        npm_registry = npm_registry,
        playwright_mirror = playwright_mirror,
    )
}
