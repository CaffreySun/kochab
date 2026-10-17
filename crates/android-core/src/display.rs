//! 屏幕尺寸与 density 的覆盖检测与恢复。
//!
//! 开发者选项、第三方投屏/改机工具都会通过 `wm size` / `wm density` 持久化
//! 覆盖值；恢复时如果只 reset 其中一项，另一项仍然生效，用户会以为「没恢复」。
//! 因此先完整读一次现状，再只对确实被覆盖的项执行 reset。

use adb_client::AdbClient;
use serde::Serialize;

use crate::device::{map_adb_error, require_success};
use crate::error::Result;

/// 一次 `wm size` / `wm density` 的现状。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayOverride {
    /// `Physical size` 或 `Physical density` 的原始值（如 `1080x2160` / `440`）
    pub physical_size: Option<String>,
    pub physical_density: Option<String>,
    /// 只有被覆盖时才存在
    pub override_size: Option<String>,
    pub override_density: Option<String>,
}

impl DisplayOverride {
    /// 任意一项被覆盖即视为「需要恢复」。
    pub fn is_overridden(&self) -> bool {
        self.override_size.is_some() || self.override_density.is_some()
    }

    /// 面向用户的一行描述，例如 `720x1440 → 1080x2160；密度 320 → 440`。
    pub fn detail(&self) -> String {
        let mut parts = Vec::new();
        if let Some(current) = &self.override_size {
            match &self.physical_size {
                Some(physical) => parts.push(format!("{current} → {physical}")),
                None => parts.push(format!("尺寸 {current}")),
            }
        }
        if let Some(current) = &self.override_density {
            match &self.physical_density {
                Some(physical) => parts.push(format!("密度 {current} → {physical}")),
                None => parts.push(format!("密度 {current}")),
            }
        }
        parts.join("；")
    }
}

/// 恢复结果。`overridden == false` 时没有执行任何 reset。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayReset {
    pub overridden: bool,
    /// 恢复前被覆盖的原始值（`None` 表示本来就无需恢复）
    pub before: DisplayOverride,
    /// 直接展示给用户的结果文案
    pub message: String,
}

/// 解析 `wm size` 的完整输出。
///
/// ```text
/// Physical size: 1080x2160
/// Override size: 720x1440
/// ```
pub fn parse_wm_size(output: &str) -> (Option<String>, Option<String>) {
    let mut physical = None;
    let mut overrode = None;
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Physical size:") {
            physical = non_empty(rest);
        } else if let Some(rest) = line.strip_prefix("Override size:") {
            overrode = non_empty(rest);
        }
    }
    (physical, overrode)
}

/// 解析 `wm density` 的完整输出。
///
/// ```text
/// Physical density: 440
/// Override density: 320
/// ```
pub fn parse_wm_density(output: &str) -> (Option<String>, Option<String>) {
    let mut physical = None;
    let mut overrode = None;
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Physical density:") {
            physical = non_empty(rest);
        } else if let Some(rest) = line.strip_prefix("Override density:") {
            overrode = non_empty(rest);
        }
    }
    (physical, overrode)
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// 读取当前覆盖状态。两条命令都必须成功，否则无法判断「恢复是否完整」。
pub async fn inspect(client: &AdbClient, serial: &str) -> Result<DisplayOverride> {
    let size = run(client, serial, "wm size").await?;
    let density = run(client, serial, "wm density").await?;
    let (physical_size, override_size) = parse_wm_size(&size);
    let (physical_density, override_density) = parse_wm_density(&density);
    Ok(DisplayOverride {
        physical_size,
        physical_density,
        override_size,
        override_density,
    })
}

/// 只重置确实被覆盖的项。
///
/// `wm size reset` / `wm density reset` 在未覆盖时本身也是幂等的，但这里仍然
/// 先判断再执行：返回值要能如实告诉用户「本来就不需要恢复」，
/// 而不是每次点完都弹一句成功。
pub async fn reset(client: &AdbClient, serial: &str) -> Result<DisplayReset> {
    let before = inspect(client, serial).await?;
    if !before.is_overridden() {
        return Ok(DisplayReset {
            overridden: false,
            before,
            message: "屏幕尺寸与 density 都是系统默认值，无需恢复".to_owned(),
        });
    }

    if before.override_size.is_some() {
        run(client, serial, "wm size reset").await?;
    }
    if before.override_density.is_some() {
        run(client, serial, "wm density reset").await?;
    }

    // 重置后重新读一次，确认覆盖项真的消失了；读不到也不谎报成功。
    let after = inspect(client, serial).await?;
    let still = after.is_overridden();
    let message = if still {
        format!("已执行恢复，但设备仍报告覆盖值：{}", after.detail())
    } else {
        format!("已恢复屏幕：{}", before.detail())
    };

    Ok(DisplayReset {
        overridden: true,
        before,
        message,
    })
}

async fn run(client: &AdbClient, serial: &str, command: &str) -> Result<String> {
    let out = client.shell(serial, command).await.map_err(map_adb_error)?;
    Ok(require_success(out, command)?.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: &str = "Physical size: 1080x2160\n";
    const SIZE_OVERRIDDEN: &str = "Physical size: 1080x2160\nOverride size: 720x1440\n";
    const DENSITY: &str = "Physical density: 440\n";
    const DENSITY_OVERRIDDEN: &str = "Physical density: 440\nOverride density: 320\n";

    #[test]
    fn 未覆盖时只有物理值() {
        let (physical, overrode) = parse_wm_size(SIZE);
        assert_eq!(physical.as_deref(), Some("1080x2160"));
        assert!(overrode.is_none());

        let (physical, overrode) = parse_wm_density(DENSITY);
        assert_eq!(physical.as_deref(), Some("440"));
        assert!(overrode.is_none());
    }

    #[test]
    fn 覆盖时同时保留物理值() {
        let (physical, overrode) = parse_wm_size(SIZE_OVERRIDDEN);
        assert_eq!(physical.as_deref(), Some("1080x2160"));
        assert_eq!(overrode.as_deref(), Some("720x1440"));

        let (physical, overrode) = parse_wm_density(DENSITY_OVERRIDDEN);
        assert_eq!(physical.as_deref(), Some("440"));
        assert_eq!(overrode.as_deref(), Some("320"));
    }

    #[test]
    fn 空输出不产生假值() {
        assert_eq!(parse_wm_size(""), (None, None));
        assert_eq!(parse_wm_density("\n"), (None, None));
    }

    #[test]
    fn 只有_override_也算覆盖() {
        let override_info = DisplayOverride {
            override_size: Some("720x1440".into()),
            ..DisplayOverride::default()
        };
        assert!(override_info.is_overridden());
        assert_eq!(override_info.detail(), "尺寸 720x1440");
    }

    #[test]
    fn 详情只列出被覆盖的项() {
        let both = DisplayOverride {
            physical_size: Some("1080x2160".into()),
            physical_density: Some("440".into()),
            override_size: Some("720x1440".into()),
            override_density: Some("320".into()),
        };
        assert_eq!(both.detail(), "720x1440 → 1080x2160；密度 320 → 440");

        let density_only = DisplayOverride {
            physical_density: Some("440".into()),
            override_density: Some("320".into()),
            ..DisplayOverride::default()
        };
        assert_eq!(density_only.detail(), "密度 320 → 440");
    }
}
