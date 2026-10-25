# Android 桌面小组件

独立的 Android 应用，用于在桌面查看 FF14 信息：

- PVP：纷争前线、水晶冲突的当前地图、下一张和倒计时，拖动组件可调整信息密度。
- 鱼窗：按鱼名搜索，最多选择十种鱼。
- 国服活动与综合概览，点击组件打开网站。

首次无网时，PVP 使用安装包内置国服规则；联网后校验。鱼窗和活动使用成功缓存，数据失效会提示。后台刷新和换图重绘受系统省电策略影响，不保证准点。

## 构建

需要 JDK 17、Android SDK Platform 35 和 Build Tools 35。配置 `JAVA_HOME`、`ANDROID_HOME` 后，在本目录执行：

```sh
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Windows 使用 `.\gradlew.bat`。使用仓库内 Wrapper，依赖版本、锁文件与 SHA256 校验资料一起维护。调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

Debug 使用独立的 `.debug` 包名并连接预览环境；Release 连接正式环境。调试包不等于正式签名的发布包。

## 数据与范围

组件只读取公开摘要，不传输个人钓获记录或 WebDAV 密码。国服活动不会用于冒充国际服日程。

PVP 内置规则由根目录的 `pnpm run generate:android-pvp` 生成，`pnpm run check:android-pvp` 检查一致性。国服前线按北京时间 23:00 轮换，水晶冲突按每小时轮换；游戏运营调整后需更新规则。

当前没有 Android 独立定时通知、锁屏实时活动或 iOS 工程。

- [摘要 API](../../docs/mobile-widgets.md)
- [设备验收](../../docs/mobile-widget-acceptance.md)
- [PVP 响应式布局](../../docs/pvp-responsive-widgets.md)
- [小米兼容与负一屏限制](../../docs/pvp-xiaomi-compatibility.md)
