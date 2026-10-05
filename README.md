# adek-supabase-stack

Adek Koçluk için self-hosted Supabase yığını (Dokploy üzerinde çalışır).

## Bu depo nedir

Supabase'in resmi self-host paketinin **sabitlenmiş** bir kopyası:

```
upstream: supabase/supabase
commit:   0a40e0e5e59043549877ab393e34f7ebe5f5a8e1   (25 Nisan 2025)
```

Bu commit, Dokploy'daki şablonun türetildiği sürümün **tam karşılığı** —
13 imajın 13'ü birebir aynıydı. Bu yüzden `volumes/` altındaki destek
dosyaları `docker-compose.yml` ile uyumludur. Master'dan alınsaydı
`kong.yml` tanımsız değişkenler (`$SUPABASE_PUBLISHABLE_KEY`,
`$LUA_AUTH_EXPR`) isteyeceği için Kong hiç başlamazdı.

## Upstream'den TEK farkı

```diff
- image: supabase/postgres:15.8.1.060
+ image: supabase/postgres:17.6.1.178
```

**Zorunlu.** Taşınan veritabanı yedeği PostgreSQL **17.6**'dan alındı
(canlı: `17.6.1.121`). PostgreSQL yedekleri ileriye uyumludur, geriye
değil — PG 15'e geri yüklenemezdi.

## Neden git deposu

Dokploy'da "Raw" compose kullanılırsa `volumes/` altındaki 11 destek
dosyası sunucuda oluşmaz; `db` rolleri kuramaz, `kong` yapılandırmasız
başlar, `vector` ve `supavisor` hiç kalkmaz. Git provider ile dosyalar
her deploy'da garanti yerinde olur.

## Dokploy ayarları

| Alan | Değer |
|---|---|
| Provider | Git |
| Branch | `main` |
| Compose Path | `docker-compose.yml` |
| Domain → Service | `kong`, port `8000` |

Gizli değerler **bu depoda değil**, Dokploy'un Environment sekmesinde.

## Bilinen kozmetik uyumsuzluk

`volumes/logs/vector.yml` yedi konteyner adı bekler; compose ikisini
farklı adlandırır (`supabase-edge-functions` ↔ `supabase-functions`,
`realtime-dev.supabase-realtime` ↔ `supabase-realtime`). Upstream'in
kendi tutarsızlığı. Etkisi yalnızca Studio'nun Logs ekranında bu iki
servisin kayıtlarının görünmemesi; çalışmaya etkisi yok.
