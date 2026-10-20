# Coopanion 可攜版

此目錄提供 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的
Windows、macOS 與 Linux 可攜啟動工具。工具維護於
[aaaeeezynx/coopanion-portable](https://github.com/aaaeeezynx/coopanion-portable)，
這是一個保留上游完整 Git 歷史的正統 fork。

可攜工具是上游應用程式外層的整合層，不會把上游發行 binary 直接放進 Git。
安裝時會下載官方上游 release，並使用 SHA-256 驗證檔案。

## 支援平台

| 平台 | 架構 | 安裝程式 |
| --- | --- | --- |
| Windows 10/11 | x64 | `Install-Coopanion-Windows.cmd` |
| macOS | Apple Silicon（arm64） | `Install-Coopanion-macOS.command` |
| Linux | x64 | `Install-Coopanion-Linux.sh` |

可攜版目錄必須可寫入。macOS 與 Linux 需要 Git；Windows 會優先使用
Coopanion 內附的 Git。

## 安裝

在新裝置先 clone fork，進入可攜版目錄：

```text
git clone https://github.com/aaaeeezynx/coopanion-portable.git
cd coopanion-portable/portable
```

再依裝置執行對應安裝程式。

Windows：

```powershell
.\Install-Coopanion-Windows.cmd
```

macOS：

```bash
bash "Install-Coopanion-macOS.command"
```

Linux：

```bash
bash "Install-Coopanion-Linux.sh"
```

需要重新安裝時，Windows 可加 `-Force`，macOS 與 Linux 可加 `--force`。
Windows 與 macOS 的舊版會移到本機備份目錄；Linux 會保留帶時間戳的
AppImage 備份。

## 啟動

請使用啟動器，不要直接開啟應用程式執行檔。啟動器會先檢查個人設定
倉庫、同步變更、套用 OpenCodeGo 相容設定，再啟動 Coopanion。

- Windows：`Start-Coopanion.cmd`
- macOS：雙擊 `Start Coopanion.command`
- Linux：`bash "Start-Coopanion-Linux.sh"`

第一次啟動時，如果 `profile/` 不存在，會從以下倉庫 clone：

```text
https://github.com/aaaeeezynx/coopanion-profile.git
```

若該倉庫是私人倉庫，GitHub 可能會要求登入或授權。

## 會同步的內容

同步工具採用白名單，只會同步：

- 適合跨裝置共用的語言、主題、桌寵、觸控與語音辨識設定。
- 夥伴 workspace 中的 Markdown 與純文字記憶、人設檔案。
- `avatar.png` 頭像。

以下內容只保留在本機，不會同步：

- API Key、provider `.env`、登入資料、Token 或任何秘密。
- Provider 設定、本機路徑、權限、視窗位置、快取、日誌、資料庫、
  擴充套件、模型與 blobs。
- 應用程式 binary 與下載的 release 壓縮檔。
- 不在個人設定白名單內的其他檔案。

每次提交前會執行隱私掃描；若發現常見憑證格式、Token 或私鑰，同步會停止。

## 同步時機

同步會在以下時機執行：

- 啟動器開始執行時。
- Coopanion 執行期間，受管理檔案變更後數秒內。
- Coopanion 結束時。

個人設定倉庫位於 `profile/`，上層 fork 倉庫不會提交這個目錄。同步不會
force push。若 Windows 與 Mac 同時修改同一內容而無法乾淨 rebase，程式會
停止同步、保留本機修改，並在 `data/.portable-sync/` 建立備份。

若要查看結果，可檢查：

```text
data/.portable-sync/status.json
data/.portable-sync/sync.log
```

## OpenCodeGo 相容性

目前上游的 `coo` provider 不支援自訂任意 HTTP header，但 OpenCodeGo 需要
穩定的 `x-opencode-session`。此 fork 的可攜工具會：

1. 保留既有 OpenCode provider 設定。
2. 將 kind 改為 `openai-responses-compat`。
3. 保留既有 options 與 headers。
4. 加入各平台固定且穩定的 `x-opencode-session`。

安裝與每次啟動都會檢查此設定。轉換程式不會讀取或修改 provider 的 `.env`
憑證。全新裝置第一次設定 OpenCode provider 後，重新啟動 Coopanion 即會
自動套用相容設定，不需要再手動修改 JSON。

這是可攜工具層的 workaround，尚未成為上游原生功能。上游 Issue 會用來討論
通用的 provider header 支援與後續貢獻方式。

## 隱私

個人設定倉庫只適合放記憶與可公開分享的設定，不適合放秘密。除非已確認
所有同步內容都能公開，否則請將 `coopanion-profile` 設為私人倉庫。不要把
API Key、Token、私鑰或裝置憑證寫進記憶檔案。

可攜版目錄中的 `.gitignore` 會排除 `app/`、`data/`、`_downloads/`、
`profile/`、`.tmp/`、環境檔、常見憑證檔與作業系統產生的中繼檔。完整規則
請見 `.gitignore`。

## 授權

上游專案與此處的可攜整合變更採用 GNU Affero General Public License
version 3 or later。請參閱倉庫根目錄的 `LICENSE` 與
`portable/NOTICE.md`。
