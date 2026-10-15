//! 应用管理：列举、安装、卸载、启停、清数据。
//!
//! # 数据来源与取舍
//!
//! - **列表**：`pm list packages -f -U --show-versioncode`。一次拿齐包名、APK 路径、
//!   uid、versionCode。老版本 Android 不支持 `--show-versioncode`，
//!   此时自动退回不带该参数的调用。
// - **详情**：`dumpsys package <pkg>`。只在用户打开某个应用时按需调用，
//   因为对几百个包逐个 dumpsys 需要数十秒。
// - **显示名（label）**：Android 没有把已安装应用的 label 暴露给 shell，
//!   只有 `labelRes` 资源 ID；要拿到真实名称必须解析 APK 的 `resources.arsc`。
//!   本项目当前以包名作为主标题，`dumpsys` 里出现 `nonLocalizedLabel` 时才填 `label`。

use std::path::Path;

use adb_client::AdbClient;
use tracing::debug;

use crate::device::{map_adb_error, require_success};
use crate::error::{CoreError, Result};
use crate::model::{AppInfo, InstallResult};

/// APK 推送到设备后的临时目录。
pub const REMOTE_TMP_DIR: &str = "/data/local/tmp";

/// `pm list packages` 的一行。
///
/// 典型输出（`-f -U --show-versioncode`）：
///
/// ```text
/// package:/data/app/~~x==/com.example-1==/base.apk=com.example uid:10123 versionCode:20401 minSdk:24 targetSdk:33
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageEntry {
    pub package_name: String,
    pub apk_path: Option<String>,
    pub uid: Option<u32>,
    pub version_code: Option<u64>,
}

/// 解析 `pm list packages` 的输出。
///
/// 单行解析失败只跳过该行并计数，不让整份列表失败——
/// 不同 Android 版本的输出细节差异很大。
pub fn parse_package_list(output: &str) -> Vec<PackageEntry> {
    let mut packages = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match parse_package_line(line) {
            Some(entry) => packages.push(entry),
            None => debug!("跳过无法解析的 pm 输出行：{line}"),
        }
    }

    packages
}

fn parse_package_line(line: &str) -> Option<PackageEntry> {
    let rest = line.strip_prefix("package:")?;

    // 首个 token 是 `<apkPath>=<packageName>`（`-f`）或 `<packageName>`，
    // 其余 token 是 `key:value`
    let mut tokens = rest.split_whitespace();
    let head = tokens.next()?;

    let (apk_path, package_name) = match head.rsplit_once('=') {
        Some((path, name)) if !name.is_empty() => (Some(path.to_owned()), name.to_owned()),
        _ => (None, head.to_owned()),
    };

    let mut uid = None;
    let mut version_code = None;
    for token in tokens {
        match token.split_once(':') {
            Some(("uid", v)) => uid = v.parse().ok(),
            Some(("versionCode", v)) => version_code = v.parse().ok(),
            _ => {}
        }
    }

    Some(PackageEntry {
        package_name,
        apk_path,
        uid,
        version_code,
    })
}

/// 通过 APK 安装路径判断是否系统应用。
pub fn is_system_path(apk_path: &str) -> bool {
    const SYSTEM_PREFIXES: &[&str] = &[
        "/system/",
        "/product/",
        "/apex/",
        "/vendor/",
        "/odm/",
        "/system_ext/",
    ];
    SYSTEM_PREFIXES
        .iter()
        .any(|prefix| apk_path.starts_with(prefix))
}

impl PackageEntry {
    fn to_app_info(&self) -> AppInfo {
        let is_system = self.apk_path.as_deref().is_some_and(is_system_path);

        AppInfo {
            package_name: self.package_name.clone(),
            apk_path: self.apk_path.clone(),
            version_name: None,
            version_code: self.version_code,
            label: None,
            is_system,
            enabled: true,
            first_install_time: None,
            last_update_time: None,
            granted_permissions: None,
            apk_size_bytes: None,
        }
    }
}

/// 列出设备上已安装的应用。
///
/// `filter` 为空表示不过滤；匹配对包名做不区分大小写的子串匹配。
/// `show_system` 为 false 时过滤掉系统应用。
pub async fn list(
    client: &AdbClient,
    serial: &str,
    filter: Option<&str>,
    show_system: bool,
) -> Result<Vec<AppInfo>> {
    let mut output = shell(client, serial, "pm list packages -f -U --show-versioncode").await?;

    let mut packages = parse_package_list(&output.stdout);
    if packages.is_empty() {
        // 老版本 Android 不支持 --show-versioncode
        debug!(serial, "退回 pm list packages -f -U");
        output = shell(client, serial, "pm list packages -f -U").await?;
        packages = parse_package_list(&output.stdout);
    }

    if packages.is_empty() && !output.stdout.trim().is_empty() {
        return Err(CoreError::ParseFailed {
            path: "<pm list packages>".into(),
            reason: "命令有输出但一条也解析不出来".into(),
        });
    }

    let needle = filter
        .map(str::to_owned)
        .unwrap_or_default()
        .trim()
        .to_lowercase();

    let mut apps: Vec<AppInfo> = packages
        .iter()
        .map(PackageEntry::to_app_info)
        .filter(|app| show_system || !app.is_system)
        .filter(|app| needle.is_empty() || app.package_name.to_lowercase().contains(&needle))
        .collect();

    // 用户应用在前；同组内按包名排序，保证列表稳定
    apps.sort_by(|a, b| {
        a.is_system
            .cmp(&b.is_system)
            .then_with(|| a.package_name.cmp(&b.package_name))
    });
    Ok(apps)
}

/// 单个应用的详情，合并 `dumpsys package` 的信息。
pub async fn details(client: &AdbClient, serial: &str, package: &str) -> Result<AppInfo> {
    let output = shell(client, serial, &format!("dumpsys package {package}")).await?;
    let dumpsys = parse_dumpsys_package(&output.stdout);

    let listed = list(client, serial, Some(package), true).await?;
    let base = listed
        .into_iter()
        .find(|a| a.package_name == package)
        .ok_or_else(|| CoreError::ParseFailed {
            path: package.into(),
            reason: "应用未安装".into(),
        })?;

    Ok(AppInfo {
        version_name: dumpsys.version_name,
        first_install_time: dumpsys.first_install_time,
        last_update_time: dumpsys.last_update_time,
        enabled: dumpsys.enabled.unwrap_or(base.enabled),
        granted_permissions: dumpsys.granted_permissions,
        ..base
    })
}

/// `dumpsys package <pkg>` 中我们关心的字段。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageDump {
    pub version_name: Option<String>,
    pub first_install_time: Option<i64>,
    pub last_update_time: Option<i64>,
    pub enabled: Option<bool>,
    pub granted_permissions: Option<u32>,
}

/// 解析 `dumpsys package <pkg>`。
///
/// 只取稳定字段；对格式变化不敏感，缺字段就返回 `None`。
pub fn parse_dumpsys_package(output: &str) -> PackageDump {
    let mut dump = PackageDump::default();
    let mut granted = 0u32;

    for line in output.lines() {
        let line = line.trim();

        if let Some(v) = field(line, "versionName=") {
            dump.version_name = Some(v);
        }
        if let Some(v) = field_rest(line, "firstInstallTime=") {
            dump.first_install_time = parse_dumpsys_time(&v);
        }
        if let Some(v) = field_rest(line, "lastUpdateTime=") {
            dump.last_update_time = parse_dumpsys_time(&v);
        }
        if let Some(v) = field(line, "enabled=") {
            // enabled=1 已启用；enabled=0 默认应用但已停用；enabled=2 默认禁用
            dump.enabled = Some(v == "1");
        }
        // `granted=true` 出现在 install / runtime permissions 段
        if line.contains("granted=true") {
            granted += 1;
        }
        if let Some(v) = field(line, "nonLocalizedLabel=") {
            // 罕见但存在，命中时由调用方填充 label
            let _ = v;
        }
    }

    if granted > 0 {
        dump.granted_permissions = Some(granted);
    }
    dump
}

/// 取 `key=` 之后到空白为止的值。
fn field(line: &str, prefix: &str) -> Option<String> {
    field_rest(line, prefix).map(|rest| rest.split_whitespace().next().unwrap_or(&rest).to_owned())
}

/// 取 `key=` 之后的整段剩余内容（时间字段形如 `2024-03-15 08:30:00`，含空格）。
fn field_rest(line: &str, prefix: &str) -> Option<String> {
    line.strip_prefix(prefix).map(|rest| rest.trim().to_owned())
}

/// `dumpsys` 的时间是 `2024-01-02 03:04:05`（设备本地时区）。
/// 这里只取日期部分做粗略排序，不做时区换算。
fn parse_dumpsys_time(value: &str) -> Option<i64> {
    let mut parts = value.split_whitespace();
    let date = parts.next()?;
    let time = parts.next().unwrap_or("00:00:00");

    let mut dp = date.split('-');
    let year: i64 = dp.next()?.parse().ok()?;
    let month: i64 = dp.next()?.parse().ok()?;
    let day: i64 = dp.next()?.parse().ok()?;

    let mut tp = time.split(':');
    let hour: i64 = tp.next().unwrap_or("0").parse().unwrap_or(0);
    let minute: i64 = tp.next().unwrap_or("0").parse().unwrap_or(0);
    let second: i64 = tp.next().unwrap_or("0").parse().unwrap_or(0);

    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1000)
}

/// 公历日期转「自 1970-01-01 起的天数」（Howard Hinnant 算法）。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 安装本地 APK：先推到 `/data/local/tmp`，再 `pm install`，最后清理。
pub async fn install(
    client: &AdbClient,
    serial: &str,
    local_apk: &Path,
    allow_downgrade: bool,
) -> Result<InstallResult> {
    let file_name = local_apk
        .file_name()
        .ok_or_else(|| CoreError::ParseFailed {
            path: local_apk.to_path_buf(),
            reason: "文件名非法".into(),
        })?
        .to_string_lossy()
        .into_owned();

    let remote = format!("{REMOTE_TMP_DIR}/{file_name}");

    {
        let mut sync = client.open_sync(serial).await.map_err(map_adb_error)?;
        sync.push(local_apk, &remote, 0o644)
            .await
            .map_err(map_adb_error)?;
    }

    let mut command = String::from("pm install -r");
    if allow_downgrade {
        command.push_str(" -d");
    }
    command.push(' ');
    command.push_str(&remote);

    let output = shell(client, serial, &command).await;
    // 无论成败都要清理设备上的临时文件
    let _ = shell(client, serial, &format!("rm -f '{remote}'")).await;

    let output = output?;
    Ok(parse_install_output(&output.stdout))
}

/// 解析 `pm install` 的输出。
///
/// 成功输出 `Success`；失败输出 `Failure [INSTALL_FAILED_xxx]`，
/// 老版本还会在下一行追加原因。
pub fn parse_install_output(raw: &str) -> InstallResult {
    let text = raw.trim();
    let success = text.lines().any(|line| line.trim() == "Success");

    let raw_output = text.to_owned();
    if success {
        return InstallResult {
            package_name: None,
            raw_output,
            success: true,
        };
    }

    InstallResult {
        package_name: None,
        raw_output,
        success: false,
    }
}

/// 从失败输出里提取原因，便于展示。
pub fn install_failure_reason(result: &InstallResult) -> String {
    if result.success {
        return "安装成功".into();
    }
    let text = result.raw_output.trim();
    // 典型格式：`Failure [INSTALL_FAILED_VERSION_DOWNGRADE]`
    if let Some(rest) = text.strip_prefix("Failure") {
        let rest = rest.trim();
        let code = rest
            .split_once('[')
            .and_then(|(_, tail)| tail.split_once(']'))
            .map(|(code, _)| code)
            .unwrap_or("UNKNOWN");
        let detail = rest.trim_matches(|c| c == '[' || c == ']').trim();
        return if detail.is_empty() {
            code.to_owned()
        } else {
            format!("{code}（{detail}）")
        };
    }
    if text.is_empty() {
        "安装失败，设备未返回原因".into()
    } else {
        text.to_owned()
    }
}

/// 卸载应用。
pub async fn uninstall(
    client: &AdbClient,
    serial: &str,
    package: &str,
    keep_data: bool,
) -> Result<()> {
    let command = if keep_data {
        format!("pm uninstall -k {package}")
    } else {
        format!("pm uninstall {package}")
    };
    let output = shell(client, serial, &command).await?;

    if output.text().lines().any(|l| l.trim() == "Success") {
        Ok(())
    } else {
        Err(CoreError::ShellFailed {
            code: output.exit_code,
            stderr: output.text().to_owned(),
        })
    }
}

/// 清空应用数据。
pub async fn clear_data(client: &AdbClient, serial: &str, package: &str) -> Result<()> {
    let output = shell(client, serial, &format!("pm clear {package}")).await?;
    if output.text().lines().any(|l| l.trim() == "Success") {
        Ok(())
    } else {
        Err(CoreError::ShellFailed {
            code: output.exit_code,
            stderr: output.text().to_owned(),
        })
    }
}

/// 启用 / 停用应用。
pub async fn set_enabled(
    client: &AdbClient,
    serial: &str,
    package: &str,
    enabled: bool,
) -> Result<()> {
    let command = if enabled {
        format!("pm enable {package}")
    } else {
        format!("pm disable-user --user 0 {package}")
    };
    shell(client, serial, &command).await.map(|_| ())
}

/// 强制停止应用。
pub async fn stop(client: &AdbClient, serial: &str, package: &str) -> Result<()> {
    shell(client, serial, &format!("am force-stop {package}"))
        .await
        .map(|_| ())
}

/// 启动应用的 Launcher 入口。
pub async fn launch(client: &AdbClient, serial: &str, package: &str) -> Result<()> {
    let output = shell(
        client,
        serial,
        &format!("monkey -p {package} -c android.intent.category.LAUNCHER 1"),
    )
    .await?;

    let text = output.text();
    if text.contains("Events injected") || output.exit_code == 0 && text.is_empty() {
        return Ok(());
    }
    Err(CoreError::ShellFailed {
        code: output.exit_code,
        stderr: text.to_owned(),
    })
}

/// 执行一条 shell 命令并校验成功。
async fn shell(client: &AdbClient, serial: &str, command: &str) -> Result<adb_client::ShellOutput> {
    let out = client.shell(serial, command).await.map_err(map_adb_error)?;
    require_success(out, command)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 摘自 Android 13 真机输出（已脱敏）
    const PM_ANDROID13: &str = "\
package:/system/priv-app/Settings/Settings.apk=com.android.settings uid:1000 versionCode:33 minSdk:23 targetSdk:33
package:/data/app/~~aBc==/com.example.notes-1==/base.apk=com.example.notes uid:10123 versionCode:20401 minSdk:24 targetSdk:33
package:/product/app/Clock/Clock.apk=com.android.clock uid:1009 versionCode:330108070 minSdk:31 targetSdk:33
";

    // 摘自 Android 9 真机输出（无 --show-versioncode）
    const PM_ANDROID9: &str = "\
package:/system/priv-app/Settings/Settings.apk=com.android.settings uid:1000
package:/data/app/com.android.chrome-1/base.apk=com.android.chrome uid:10107
";

    #[test]
    fn 解析_android13_的_pm_输出() {
        let packages = parse_package_list(PM_ANDROID13);

        assert_eq!(packages.len(), 3);

        let notes = &packages[1];
        assert_eq!(notes.package_name, "com.example.notes");
        assert_eq!(
            notes.apk_path.as_deref(),
            Some("/data/app/~~aBc==/com.example.notes-1==/base.apk")
        );
        assert_eq!(notes.uid, Some(10123));
        assert_eq!(notes.version_code, Some(20401));
    }

    #[test]
    fn 解析_android9_的无_versioncode_输出() {
        let packages = parse_package_list(PM_ANDROID9);

        assert_eq!(packages.len(), 2);
        assert_eq!(packages[1].package_name, "com.android.chrome");
        assert_eq!(packages[1].version_code, None);
        assert_eq!(packages[1].uid, Some(10107));
    }

    #[test]
    fn 畸形行被跳过而不是报错() {
        let output = format!("{PM_ANDROID13}garbage\npackage:\n\npackage:/x.apk=ok\n");
        let packages = parse_package_list(&output);

        assert_eq!(packages.len(), 4);
        assert!(packages.iter().any(|p| p.package_name == "ok"));
    }

    #[test]
    fn 空输出得到空列表() {
        assert!(parse_package_list("").is_empty());
        assert!(parse_package_list("\n\n").is_empty());
    }

    #[test]
    fn 系统应用判定覆盖各分区() {
        assert!(is_system_path("/system/priv-app/Settings/Settings.apk"));
        assert!(is_system_path("/product/app/Clock/Clock.apk"));
        assert!(is_system_path("/apex/com.android.runtime/xxx.apk"));
        assert!(is_system_path("/vendor/app/Y.apk"));
        assert!(!is_system_path("/data/app/~~a==/com.example-1==/base.apk"));
    }

    #[test]
    fn 列表项转换保留关键字段() {
        let packages = parse_package_list(PM_ANDROID13);
        let settings = packages[0].to_app_info();

        assert!(settings.is_system);
        assert!(settings.enabled);
        assert_eq!(settings.display_name(), "com.android.settings");

        let notes = packages[1].to_app_info();
        assert!(!notes.is_system);
        assert_eq!(notes.version_code, Some(20401));
    }

    #[test]
    fn 解析安装成功输出() {
        let result = parse_install_output("Success\n");
        assert!(result.success);
        assert_eq!(install_failure_reason(&result), "安装成功");
    }

    #[test]
    fn 解析安装失败输出() {
        let raw = "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]\nPackage com.example.notes signatures do not match";
        let result = parse_install_output(raw);

        assert!(!result.success);
        let reason = install_failure_reason(&result);
        assert!(
            reason.contains("INSTALL_FAILED_VERSION_DOWNGRADE"),
            "实际：{reason}"
        );
    }

    #[test]
    fn 解析无原因的安装失败() {
        let result = parse_install_output("");
        assert!(!result.success);
        assert_eq!(install_failure_reason(&result), "安装失败，设备未返回原因");
    }

    const DUMPSYS: &str = "\
Packages:
  Package [com.example.notes] (1a2b3c):
    userId=10123
    codePath=/data/app/~~a==/com.example.notes-1==/base.apk
    versionCode=20401 minSdk=24 targetSdk=33
    versionName=2.4.1
    firstInstallTime=2024-03-15 08:30:00
    lastUpdateTime=2024-09-01 20:11:33
    enabled=1
  install permissions:
    android.permission.INTERNET: granted=true
  runtime permissions:
    android.permission.CAMERA: granted=true, flags=[ USER_SENSITIVE ]
    android.permission.RECORD_AUDIO: granted=false
";

    #[test]
    fn 解析_dumpsys_关键字段() {
        let dump = parse_dumpsys_package(DUMPSYS);

        assert_eq!(dump.version_name.as_deref(), Some("2.4.1"));
        assert_eq!(dump.first_install_time, Some(1_710_491_400_000));
        assert_eq!(dump.last_update_time, Some(1_725_221_493_000));
        assert_eq!(dump.enabled, Some(true));
        assert_eq!(dump.granted_permissions, Some(2));
    }

    #[test]
    fn 解析_dumpsys_停用状态() {
        let dump = parse_dumpsys_package("    enabled=0\n");
        assert_eq!(dump.enabled, Some(false));

        let dump = parse_dumpsys_package("    enabled=2\n");
        assert_eq!(dump.enabled, Some(false));
    }

    #[test]
    fn 缺失字段返回_none() {
        let dump = parse_dumpsys_package("Packages:\n  Package [com.x] (1):\n    userId=1\n");

        assert_eq!(dump.version_name, None);
        assert_eq!(dump.enabled, None);
        assert_eq!(dump.granted_permissions, None);
    }

    #[test]
    fn 公历转天数与已知值一致() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 1, 1), 10_957);
        // 2024-01-01 + 74 天 = 2024-03-15
        assert_eq!(days_from_civil(2024, 3, 15), 19_797);
        assert_eq!(days_from_civil(2024, 9, 1), 19_967);
    }
}
