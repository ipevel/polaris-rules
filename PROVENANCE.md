# 产出谱系（自动生成，勿手工编辑）

生成时间：2026-10-24T03:40:33.573Z
版本：VERSION 17

## 上游坐标

- 分流清单：`ACL4SSR/ACL4SSR` @ `3024bf8b2c9db5bf8807c4595674be8bbc22bd86`（2026-10-24T02:51:21Z）
- geo 数据库：`MetaCubeX/meta-rules-dat` release `latest`（2026-10-24T00:55:34Z）

## 两种形态

- `rules/*.txt`：人可读形态（带表头），用来 review 与 diff。
- `dist/rules/*.list`：机可读形态（只有规则行），**App 只跟这一份打交道**；mihomo rule-provider `format: text` 直接吃。
- `dist/geo/*`：geo 数据库，与根目录 `geo/` 同字节。

## 文件来源

| 产出文件 | 条数 | 上游来源 |
|---|---|---|
| `dist/rules/ai.list` *(内核形态)* | 62 | AI.list, OpenAi.list, ClaudeAI.list, Gemini.list |
| `dist/rules/apple.list` *(内核形态)* | 29 | Apple.list |
| `dist/rules/banad.list` *(内核形态)* | 588 | BanAD.list |
| `dist/rules/banprogramad.list` *(内核形态)* | 1010 | BanProgramAD.list |
| `dist/rules/china-domain.list` *(内核形态)* | 683 | ChinaDomain.list, Baidu.list, Tencent.list, Alibaba.list, ByteDance.list, Wechat.list, UnBan.list |
| `dist/rules/china-ip.list` *(内核形态)* | 9114 | ChinaIp.list, ChinaIpV6.list, ChinaCompanyIp.list |
| `dist/rules/china-media.list` *(内核形态)* | 91 | ChinaMedia.list, Bilibili.list, NetEaseMusic.list, Download.list |
| `dist/rules/games.list` *(内核形态)* | 67 | Steam.list, Epic.list, Sony.list, Nintendo.list, Xbox.list, SteamCN.list |
| `dist/rules/onedrive.list` *(内核形态)* | 17 | OneDrive.list |
| `dist/rules/proxy-gfwlist.list` *(内核形态)* | 6890 | ProxyGFWlist.list |
| `dist/rules/proxy-media.list` *(内核形态)* | 356 | ProxyMedia.list |
| `dist/rules/social.list` *(内核形态)* | 53 | Twitter.list, Instagram.list, Facebook.list, Whatsapp.list |
| `dist/rules/streaming.list` *(内核形态)* | 174 | YouTube.list, Netflix.list, DisneyPlus.list, HBO.list, Hulu.list, AppleTV.list, BBCiPlayer.list, AbemaTV.list, DAZN.list, Twitch.list, Spotify.list, Amazon.list |
| `dist/rules/telegram.list` *(内核形态)* | 14 | Telegram.list |
| `dist/rules/tiktok.list` *(内核形态)* | 10 | TikTok.list |
| `geo/ASN.mmdb` | — | release 资产 `GeoLite2-ASN.mmdb` |
| `geo/geoip.metadb` | — | release 资产 `geoip.metadb` |
| `geo/geosite.dat` | — | release 资产 `geosite.dat` |
| `rules/ai.txt` | 62 | AI.list, OpenAi.list, ClaudeAI.list, Gemini.list |
| `rules/apple.txt` | 29 | Apple.list |
| `rules/banad.txt` | 588 | BanAD.list |
| `rules/banprogramad.txt` | 1010 | BanProgramAD.list |
| `rules/china-domain.txt` | 683 | ChinaDomain.list, Baidu.list, Tencent.list, Alibaba.list, ByteDance.list, Wechat.list, UnBan.list |
| `rules/china-ip.txt` | 9114 | ChinaIp.list, ChinaIpV6.list, ChinaCompanyIp.list |
| `rules/china-media.txt` | 91 | ChinaMedia.list, Bilibili.list, NetEaseMusic.list, Download.list |
| `rules/games.txt` | 67 | Steam.list, Epic.list, Sony.list, Nintendo.list, Xbox.list, SteamCN.list |
| `rules/onedrive.txt` | 17 | OneDrive.list |
| `rules/proxy-gfwlist.txt` | 6890 | ProxyGFWlist.list |
| `rules/proxy-media.txt` | 356 | ProxyMedia.list |
| `rules/social.txt` | 53 | Twitter.list, Instagram.list, Facebook.list, Whatsapp.list |
| `rules/streaming.txt` | 174 | YouTube.list, Netflix.list, DisneyPlus.list, HBO.list, Hulu.list, AppleTV.list, BBCiPlayer.list, AbemaTV.list, DAZN.list, Twitch.list, Spotify.list, Amazon.list |
| `rules/telegram.txt` | 14 | Telegram.list |
| `rules/tiktok.txt` | 10 | TikTok.list |

## 校验

每个文件的 SHA-256 见根目录与 `dist/` 下的 `SHA256SUMS.txt`，以及 `latest.json`。
App 侧必须**从同一个 commit** 取文件与校验值，否则会出现「新 sum 配旧字节」
（jsdelivr 各边缘缓存寿命不同，二进制与 sum 分开缓存就会这样）。

> 自洽性由 `node tools/verify.mjs` 保证：它重算 SHA256 并对 `dist/` 与根目录逐文件比对。
