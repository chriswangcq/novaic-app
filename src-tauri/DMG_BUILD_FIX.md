# DMG 打包问题修复说明

## 问题描述

在 macOS 上构建 Tauri 应用时，DMG 打包步骤失败，错误信息：
```
failed to bundle project error running bundle_dmg.sh: `failed to run /Users/.../bundle_dmg.sh`
```

## 根本原因

Tauri 生成的 `bundle_dmg.sh` 脚本依赖于 `create-dmg` 工具的 `support` 目录，该目录包含：
- `template.applescript` - 用于配置 Finder 窗口外观的 AppleScript 模板
- `eula-resources-template.xml` - EULA 资源模板

但是 Tauri 在构建过程中没有自动复制这些支持文件到构建目录，导致脚本执行失败。

## 解决方案

### 1. 安装依赖

确保已安装 `create-dmg` 工具：
```bash
brew install create-dmg
```

### 2. 自动化脚本

创建了 `setup-dmg-support.sh` 脚本，该脚本会：
- 检查 `create-dmg` 是否已安装
- 自动查找 `create-dmg` 的 support 目录
- 将支持文件复制到 Tauri 构建目录

### 3. 使用方法

#### 方式一：使用 npm script（推荐）
```bash
npm run tauri:build
```

这会自动运行 setup 脚本然后构建应用。

#### 方式二：手动运行
```bash
# 先设置 DMG 支持文件
npm run tauri:setup-dmg

# 然后使用 tauri cli 构建
cd src-tauri
tauri build
```

## 临时文件清理

如果之前的构建失败，可能会留下临时 DMG 文件（`rw.*.dmg`）：
```bash
cd src-tauri/target/release/bundle/macos
rm -f rw.*.dmg
```

## 验证

构建成功后，DMG 文件位于：
```
src-tauri/target/release/bundle/dmg/NovAIC_<version>_<arch>.dmg
```

可以使用以下命令验证 DMG 完整性：
```bash
hdiutil verify src-tauri/target/release/bundle/dmg/NovAIC_*.dmg
```

## 技术细节

### 支持文件位置
- Homebrew (Apple Silicon): `/opt/homebrew/share/create-dmg/support`
- Homebrew (Intel): `/usr/local/share/create-dmg/support`

### 所需文件
- `support/template.applescript` - Finder 窗口配置脚本
- `support/eula-resources-template.xml` - EULA 模板（可选）

## 相关工具

- `hdiutil` - macOS 系统自带的磁盘映像工具
- `SetFile` - macOS 命令行工具（用于设置文件属性）
- `create-dmg` - 第三方工具，简化 DMG 创建过程

## 未来改进

考虑向 Tauri 项目提交 issue 或 PR，建议：
1. 自动检测并复制 `create-dmg` 的支持文件
2. 或者将支持文件内联到生成的脚本中
3. 提供更清晰的错误信息，指出缺少的依赖

## 参考资源

- [create-dmg GitHub](https://github.com/create-dmg/create-dmg)
- [Tauri Bundle Configuration](https://tauri.app/v1/api/config/#bundleconfig)
- [hdiutil man page](https://ss64.com/osx/hdiutil.html)
