//! 测试辅助。
//!
//! 与 `adb-client::testing` 保持同样的约定：真机测试默认跳过，
//! 由 `pnpm test:device` 注入 `ANDROID_TEST_DEVICE` 后真正执行。

/// 读取真机集成测试的目标设备；未配置时返回 `None`（测试应当跳过）。
pub fn device_serial() -> Option<String> {
    std::env::var("ANDROID_TEST_DEVICE")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// 跳过原因，供测试输出。
pub fn skip_reason() -> &'static str {
    "未设置 ANDROID_TEST_DEVICE，跳过真机集成测试（用 `pnpm test:device` 运行）"
}

/// 创建一个一次性资源名，避免测试之间互相干扰、也便于清理。
///
/// 例如 `ac_test_1a2b3c_apk`。
pub fn temp_name(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let hash = simple_hash(&format!("{pid}:{n}"));

    // 只保留安全字符，避免出现在 shell 命令里需要转义
    let safe: String = prefix
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    format!("ac_test_{hash:x}_{n}_{safe}")
}

fn simple_hash(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 临时名唯一且安全() {
        let a = temp_name("apk");
        let b = temp_name("apk");

        assert_ne!(a, b);
        assert!(a.starts_with("ac_test_"));
        assert!(
            a.chars().all(|c| c.is_alphanumeric() || c == '_'),
            "实际：{a}"
        );
    }

    #[test]
    fn 前缀中的特殊字符被替换() {
        let name = temp_name("a/b:c");
        assert!(name.chars().all(|c| c.is_alphanumeric() || c == '_'));
        assert!(name.ends_with("a_b_c"));
    }
}
