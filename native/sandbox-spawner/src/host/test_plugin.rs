//! 只給整合測試的插件 `test-echo`：證明 `--plugins` 的列真的掛上宿主的樹。出貨的建置沒有它（`test-hooks`）。
//!
//! 設定只收 `greeting`（字串，選填）；apply 時 provide [`Greeting`]，並在 stderr 寫一行 `test-echo apply：<greeting>`。

use crate::json::Value;
use crate::kernel::{Applied, ConfigError, Cx, Fields, Plugin, PluginError, Service, Spec};

pub static SPEC: Spec = Spec { name: "test-echo", inject: &[], required: false, build };

pub struct Greeting;

impl Service for Greeting {
    const NAME: &'static str = "test-echo/greeting";
}

struct Echo {
    greeting: String,
}

fn build(value: &Value) -> Result<Box<dyn Plugin>, ConfigError> {
    let mut fields = Fields::new(value)?;
    let greeting = fields.opt_str("greeting")?.unwrap_or("hi").to_string();
    fields.finish()?;
    Ok(Box::new(Echo { greeting }))
}

impl Plugin for Echo {
    fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
        cx.provide(Greeting)?;
        eprintln!("nexus-host: test-echo apply：{}", self.greeting);
        Ok(Applied::Done)
    }
}
