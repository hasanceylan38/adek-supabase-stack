# adek-supabase-stack

Adek Koçluk için self-hosted Supabase yığını (Dokploy üzerinde çalışır).

## Sabitlenmiş upstream

```
upstream: supabase/supabase
commit:   cb52c0f42565032ab3f1cfb9a48fe4c44aad381e
```

PostgreSQL **17.6.1.136** + storage-api **v1.74.0** + GoTrue **v2.196.0**.
Geçit: **Envoy** (`api-gw` servisi, konteyner adı `supabase-envoy`).

## Neden bu sürüm

İlk denemede Nisan 2025 yığını (Kong + PG 15) kullanıldı, yalnızca `db`
imajı PostgreSQL 17'ye çekildi. Çünkü taşınacak yedek canlıdan
**PostgreSQL 17.6** ile alındı ve PG 15'e geri yüklenemez.

Bu karışım `storage` servisini kırdı:

```
Migration failed. Reason: relation "migrations" does not exist
```

`storage-api v1.22.7` (Nisan 2025), `supabase/postgres` imajının içinde
hazır gelen `storage.migrations` tablosunu arıyor; Eylül 2026 imajında o
şema farklı kurgulanıyor.

Upstream tarihçesi kontrol edildi:

| Dönem | PostgreSQL | Geçit |
|---|---|---|
| 2025-04 → 2026-06 | 15 | Kong |
| 2026-03 sonrası | 15 | Envoy |
| 2026-07 sonrası | **17.6** | **Envoy** |

**PostgreSQL 17 + Kong diye bir upstream kombinasyonu hiç olmadı.**
PG 15'e dönülemeyeceği için tek doğru yol Envoy dönemine geçmekti.

## Upstream'den TEK farkı

`api-gw` servisinin `ports:` satırı kapatıldı, yerine `expose:` kondu.
Sunucuda 8000 portunu başka bir servis tutuyor ve ilk deploy şu hatayla
düşmüştü:

```
Bind for 0.0.0.0:8000 failed: port is already allocated
```

Dokploy/Traefik bu servise Docker ağı üzerinden ulaştığı için portu
sunucuya açmaya gerek yok.

## Dokploy ayarları

| Alan | Değer |
|---|---|
| Provider | Git |
| Branch | `main` |
| Compose Path | `docker-compose.yml` |
| Domain → Service | **`api-gw`**, port `8000` |

Gizli değerler bu depoda değil, Dokploy'un Environment sekmesinde.
Kimlik doğrulama **HS256 (legacy)** yolunu kullanıyor: `JWT_KEYS`,
`JWT_JWKS` ve asimetrik anahtarlar bilerek boş bırakıldı — mobil
uygulama ve web sitesi HS256 `ANON_KEY` ile çalışıyor.

## Not: analytics ve vector yok

Bu sürümde `logflare` ve `vector` temel compose'dan çıkarılmış
(`docker-compose.logs.yml` katmanına taşınmış). İki konteyner daha az
ve önceki sürümdeki `vector.yml` konteyner-adı uyumsuzluğu da ortadan
kalktı.
