/**
 * push-gonder — bildirim satırını telefona ileten Edge Function
 *
 * NEREDEN ÇAĞRILIYOR
 * ------------------
 * Uygulamadan DEĞİL. `student_notifications`, `teacher_notifications` ve
 * `notifications` tablolarına düşen her satır için veritabanı tetikleyicisi
 * çağırıyor (dev-setup/33-push-tetikleyici.sql).
 *
 * Bu bilinçli: web ayrı bir kod tabanı. Push'u uygulama kodundan
 * tetikleseydik webde yapılan işlemler (öğrenci ekleme, ödeme, onay,
 * mesaj) telefona hiç düşmezdi. Şimdi bildirim satırı hangi koddan
 * yazılırsa yazılsın aynı yoldan geçiyor.
 *
 * İKİ PLATFORM, TEK FONKSİYON: cihazın `platform` alanına bakıp
 *   android → FCM v1        (Firebase)
 *   ios     → APNs          (doğrudan Apple, Firebase'e uğramadan)
 * Bir platformun ayarı bozuksa diğeri etkilenmiyor; hatalar ayrı ayrı
 * raporlanıyor.
 *
 * GİZLİ AYARLAR (Supabase → Edge Functions → Secrets):
 *   PUSH_TETIK_SIRRI          — tetikleyicinin gönderdiği paylaşılan sır
 *   FIREBASE_SERVICE_ACCOUNT  — servis hesabı JSON'unun TAMAMI (tek satır)
 *   APNS_ANAHTAR              — .p8 dosyasının içeriği (PEM, satır sonlarıyla)
 *   APNS_KEY_ID               — .p8 dosya adındaki 10 karakter
 *   APNS_TEAM_ID              — Apple geliştirici takım kimliği
 *   APNS_BUNDLE_ID            — uygulamanın Bundle ID'si
 *   SUPABASE_URL              — otomatik tanımlı
 *   SUPABASE_SERVICE_ROLE_KEY — otomatik tanımlı
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────────────────────
// FCM v1 için OAuth2 erişim jetonu
//
// Google'ın eski "server key" yöntemi 2024'te kapatıldı. Artık servis
// hesabıyla imzalanmış bir JWT'yi jetona çevirmek gerekiyor.
// Jeton 1 saat geçerli; her bildirimde yeniden üretmemek için önbelleğe
// alınıyor (soğuk başlangıçta yeniden üretilir, sorun değil).
// ─────────────────────────────────────────────────────────────────────────────
let jetonOnbellek: { jeton: string; bitis: number } | null = null;

interface ServisHesabi {
  client_email: string;
  private_key: string;
  project_id: string;
}

function servisHesabiOku(): ServisHesabi {
  const ham = Deno.env.get('FIREBASE_SERVICE_ACCOUNT');
  if (!ham) throw new Error('FIREBASE_SERVICE_ACCOUNT tanımlı değil');
  return JSON.parse(ham);
}

/** PEM biçimli özel anahtarı WebCrypto'nun anlayacağı hâle getirir. */
async function anahtariIceAktar(pem: string): Promise<CryptoKey> {
  const govde = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const ikili = Uint8Array.from(atob(govde), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8',
    ikili,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function base64Url(veri: Uint8Array | string): string {
  const bayt = typeof veri === 'string' ? new TextEncoder().encode(veri) : veri;
  let ikili = '';
  for (const b of bayt) ikili += String.fromCharCode(b);
  return btoa(ikili).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function erisimJetonu(): Promise<{ jeton: string; projeId: string }> {
  const hesap = servisHesabiOku();

  if (jetonOnbellek && jetonOnbellek.bitis > Date.now() + 60_000) {
    return { jeton: jetonOnbellek.jeton, projeId: hesap.project_id };
  }

  const simdi = Math.floor(Date.now() / 1000);
  const baslik = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const govde = base64Url(JSON.stringify({
    iss: hesap.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: simdi,
    exp: simdi + 3600,
  }));

  const anahtar = await anahtariIceAktar(hesap.private_key);
  const imza = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    anahtar,
    new TextEncoder().encode(`${baslik}.${govde}`),
  );
  const jwt = `${baslik}.${govde}.${base64Url(new Uint8Array(imza))}`;

  const yanit = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!yanit.ok) {
    throw new Error(`OAuth jetonu alınamadı: ${yanit.status} ${await yanit.text()}`);
  }

  const d = await yanit.json();
  jetonOnbellek = { jeton: d.access_token, bitis: Date.now() + (d.expires_in ?? 3600) * 1000 };
  return { jeton: d.access_token, projeId: hesap.project_id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tek bir cihaza gönderim
// ─────────────────────────────────────────────────────────────────────────────
interface GonderSonucu {
  basarili: boolean;
  /** Token artık geçersiz — veritabanından silinmeli */
  olu: boolean;
  hata?: string;
}

async function fcmGonder(
  jeton: string,
  projeId: string,
  token: string,
  baslik: string,
  govde: string,
  veri: Record<string, string>,
): Promise<GonderSonucu> {
  const yanit = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projeId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jeton}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: baslik, body: govde },
          // `data` alanındaki her değer METİN olmak zorunda; FCM sayı/nesne
          // kabul etmez ve sessizce 400 döner.
          data: veri,
          android: {
            // `high` olmazsa Android, Doze (uyku) kipindeki cihaza teslimi
            // erteler — bildirim saatler sonra gelebilir. Görüşme daveti
            // ve mesaj için bu kabul edilemez.
            priority: 'high',
            notification: {
              /**
               * ⚠️ BURADA `click_action: 'FLUTTER_NOTIFICATION_CLICK'` YAZIYORDU.
               *
               * O dize FLUTTER'a ait bir sözleşmedir. `click_action`
               * verildiğinde Android, bildirime dokunulunca o EYLEM ADINI
               * intent-filter'ında ilan eden bir aktivite arar. Flutter
               * şablonları MainActivity'e bu filtreyi ekler; Capacitor
               * EKLEMEZ (manifest'te böyle bir filtre yok — doğrulandı).
               *
               * Sonuç: dokunuşun gidecek hedefi yoktu. Bildirim sessizce
               * kapanıyor, uygulama AÇILMIYORDU. Kullanıcı bildirdi:
               * "basınca bildirim siliniyor, ana sayfa falan açılmadı".
               *
               * `click_action` HİÇ verilmezse Android varsayılan davranışa
               * döner: uygulamanın başlatıcı aktivitesini açar — Capacitor
               * için doğru olan da budur. Yönlendirmeyi zaten `data.rota`
               * ile biz yapıyoruz (src/lib/pushBildirim.ts).
               */
              default_sound: true,
              // KANAL KİMLİĞİ — uygulamada oluşturulan kanalla AYNI olmalı
              // (src/lib/pushBildirim.ts ve res/values/strings.xml).
              // Belirtilmezse sistem varsayılan kanalı kullanır; onun önemi
              // "default" olduğu için bildirim ekranın üstünde belirmez.
              channel_id: 'adek_bildirim',
            },
          },
        },
      }),
    },
  );

  if (yanit.ok) return { basarili: true, olu: false };

  const metin = await yanit.text();

  // Uygulama silinmiş / token yenilenmiş cihazlar. Bunları temizlemezsek
  // tablo ölü token'larla şişer ve her gönderimde boşuna istek atılır.
  const olu =
    yanit.status === 404 ||
    metin.includes('UNREGISTERED') ||
    metin.includes('INVALID_ARGUMENT');

  return { basarili: false, olu, hata: `${yanit.status} ${metin.slice(0, 200)}` };
}

// ═════════════════════════════════════════════════════════════════════════════
// APNs — iOS tarafı (Firebase YOK, doğrudan Apple)
// ═════════════════════════════════════════════════════════════════════════════
//
// iOS'ta push, Apple'ın kendi servisinden (APNs) geçiyor. Firebase'e hiç
// uğramıyor; Apple'ın imzalama anahtarı Google'a verilmiyor.
//
// Kimlik doğrulama: `.p8` anahtarıyla imzalanmış bir JWT. Üç şey gerekiyor:
//   APNS_ANAHTAR   — .p8 dosyasının içeriği (PEM)
//   APNS_KEY_ID    — anahtarın kimliği, JWT başlığındaki `kid`
//   APNS_TEAM_ID   — geliştirici takımı, JWT gövdesindeki `iss`
//   APNS_BUNDLE_ID — hedef uygulama, `apns-topic` başlığı
//
// JWT en fazla 1 saat geçerli; Apple daha sık yenilemeyi de reddediyor
// (aynı jetonu en az 20 dakika kullanmak gerekiyor). Bu yüzden önbellekte.
// ─────────────────────────────────────────────────────────────────────────────

let apnsJetonOnbellek: { jeton: string; uretim: number } | null = null;

async function apnsAnahtariIceAktar(pem: string): Promise<CryptoKey> {
  const govde = pem
    // ⚠️ ÖNCE KAÇIŞ DİZİLERİ. Ortam değişkenleri tek satır olmak zorunda
    // olduğu için PEM'in satır sonları çoğu zaman `\n` KARAKTER ÇİFTİ
    // olarak saklanır (ters bölü + n). Bunlar boşluk DEĞİLDİR; aşağıdaki
    // `\s` temizliği onları yakalamaz ve base64'ün içinde kalıp
    // çözümlemeyi bozarlar.
    //   Belirti: "Invalid keyData" ya da sessizce imza doğrulanmaması.
    // Hem gerçek satır sonuyla hem kaçış dizisiyle çalışsın diye ikisi de
    // temizleniyor.
    .replace(/\\n/g, '')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const ikili = Uint8Array.from(atob(govde), (c) => c.charCodeAt(0));
  // APNs ES256 kullanıyor: P-256 eğrisi + SHA-256
  return await crypto.subtle.importKey(
    'pkcs8',
    ikili,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function apnsJetonu(): Promise<string> {
  const anahtarPem = Deno.env.get('APNS_ANAHTAR');
  const keyId = Deno.env.get('APNS_KEY_ID');
  const teamId = Deno.env.get('APNS_TEAM_ID');
  if (!anahtarPem || !keyId || !teamId) {
    throw new Error('APNS_ANAHTAR / APNS_KEY_ID / APNS_TEAM_ID tanımlı değil');
  }

  // Apple aynı jetonun en az 20 dk kullanılmasını istiyor; 50 dk'da yeniliyoruz.
  if (apnsJetonOnbellek && Date.now() - apnsJetonOnbellek.uretim < 50 * 60_000) {
    return apnsJetonOnbellek.jeton;
  }

  const simdi = Math.floor(Date.now() / 1000);
  const baslik = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const govde = base64Url(JSON.stringify({ iss: teamId, iat: simdi }));

  const anahtar = await apnsAnahtariIceAktar(anahtarPem);
  const imza = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    anahtar,
    new TextEncoder().encode(`${baslik}.${govde}`),
  );
  // WebCrypto ECDSA imzayı ham r||s (64 bayt) olarak veriyor — JWT'nin
  // beklediği biçim de bu. DER'e çevirmek GEREKMİYOR.
  const jeton = `${baslik}.${govde}.${base64Url(new Uint8Array(imza))}`;

  apnsJetonOnbellek = { jeton, uretim: Date.now() };
  return jeton;
}

/**
 * Tek bir iOS cihazına gönderim.
 *
 * ⚠️ SANDBOX / PRODUCTION AYRIMI
 * Xcode'dan cihaza kurulan yapılar SANDBOX token'ı alır; TestFlight ve App
 * Store yapıları PRODUCTION. İkisi ayrı sunucu ve bir token yalnızca kendi
 * ortamında geçerli — yanlış ortama gönderilen token `BadDeviceToken`
 * döndürür.
 *
 * Token'a bakıp hangisi olduğunu anlamanın yolu YOK. Bu yüzden önce
 * production deneniyor, `BadDeviceToken` gelirse sandbox'a düşülüyor.
 * Böylece hem geliştirme hem mağaza yapıları tek kodla çalışıyor.
 */
async function apnsGonder(
  jeton: string,
  token: string,
  baslik: string,
  govde: string,
  veri: Record<string, string>,
): Promise<GonderSonucu> {
  const bundleId = Deno.env.get('APNS_BUNDLE_ID');
  if (!bundleId) return { basarili: false, olu: false, hata: 'APNS_BUNDLE_ID yok' };

  const yuk = JSON.stringify({
    aps: {
      alert: { title: baslik, body: govde },
      sound: 'default',
      // Bildirime dokunulunca uygulama açılsın; içerik güncellemesi de
      // isteyebilmek için `mutable-content`.
      'mutable-content': 1,
    },
    ...veri,
  });

  async function dene(sunucu: string): Promise<Response> {
    return await fetch(`https://${sunucu}/3/device/${token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jeton}`,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
        // 10 = hemen gönder. 5 = pil için ertelenebilir.
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      body: yuk,
    });
  }

  let yanit = await dene('api.push.apple.com');
  let metin = yanit.ok ? '' : await yanit.text();

  // Geliştirme yapısına gönderiyorsak production "BadDeviceToken" der
  if (!yanit.ok && metin.includes('BadDeviceToken')) {
    yanit = await dene('api.sandbox.push.apple.com');
    metin = yanit.ok ? '' : await yanit.text();
  }

  if (yanit.ok) return { basarili: true, olu: false };

  // 410 = cihaz artık kayıtlı değil (uygulama silinmiş)
  const olu = yanit.status === 410 || metin.includes('Unregistered');
  return { basarili: false, olu, hata: `${yanit.status} ${metin.slice(0, 200)}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Giriş noktası
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (istek) => {
  if (istek.method !== 'POST') {
    return new Response('Yalnızca POST', { status: 405 });
  }

  // Paylaşılan sır: bu fonksiyonu yalnızca veritabanı tetikleyicisi
  // çağırabilsin. Olmadan herkes herkese bildirim gönderebilirdi.
  const beklenen = Deno.env.get('PUSH_TETIK_SIRRI');
  if (!beklenen || istek.headers.get('x-push-sirri') !== beklenen) {
    return new Response(JSON.stringify({ hata: 'yetkisiz' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { kullanici_id, baslik, govde, veri } = await istek.json();

    if (!kullanici_id || !baslik) {
      return new Response(JSON.stringify({ hata: 'kullanici_id ve baslik zorunlu' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const yonetici = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: cihazlar, error } = await yonetici
      .from('device_tokens')
      .select('token, platform')
      .eq('user_id', kullanici_id);

    if (error) throw new Error(`device_tokens okunamadı: ${error.message}`);

    const androidTokenlari = (cihazlar ?? []).filter((c) => c.platform === 'android');
    const iosTokenlari = (cihazlar ?? []).filter((c) => c.platform === 'ios');

    if (androidTokenlari.length === 0 && iosTokenlari.length === 0) {
      return new Response(
        JSON.stringify({ gonderildi: 0, not: 'kayıtlı cihaz yok' }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    // FCM `data` alanı yalnızca metin kabul eder. APNs için de aynı biçimi
    // kullanıyoruz ki iki platformda `data.rota` aynı şekilde okunsun.
    const metinVeri: Record<string, string> = {};
    for (const [k, v] of Object.entries(veri ?? {})) {
      metinVeri[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }

    let gonderildi = 0;
    const oluTokenlar: string[] = [];
    const hatalar: string[] = [];

    // ── Android → FCM ────────────────────────────────────────────────────
    // Jeton yalnızca gönderilecek cihaz varsa alınıyor: cihaz yokken
    // Google'a gereksiz OAuth isteği atmanın anlamı yok.
    if (androidTokenlari.length > 0) {
      try {
        const { jeton, projeId } = await erisimJetonu();
        for (const cihaz of androidTokenlari) {
          const s = await fcmGonder(jeton, projeId, cihaz.token, baslik, govde ?? '', metinVeri);
          if (s.basarili) gonderildi++;
          else {
            if (s.olu) oluTokenlar.push(cihaz.token);
            if (s.hata) hatalar.push(`android: ${s.hata}`);
          }
        }
      } catch (e) {
        // Bir platformun çökmesi diğerini ENGELLEMEMELİ: Firebase ayarı
        // bozuksa iOS cihazlar yine bildirim almalı.
        hatalar.push(`android kurulum: ${String(e).slice(0, 150)}`);
      }
    }

    // ── iOS → APNs ───────────────────────────────────────────────────────
    if (iosTokenlari.length > 0) {
      try {
        const jeton = await apnsJetonu();
        for (const cihaz of iosTokenlari) {
          const s = await apnsGonder(jeton, cihaz.token, baslik, govde ?? '', metinVeri);
          if (s.basarili) gonderildi++;
          else {
            if (s.olu) oluTokenlar.push(cihaz.token);
            if (s.hata) hatalar.push(`ios: ${s.hata}`);
          }
        }
      } catch (e) {
        hatalar.push(`ios kurulum: ${String(e).slice(0, 150)}`);
      }
    }

    // Ölü token temizliği
    if (oluTokenlar.length > 0) {
      await yonetici.from('device_tokens').delete().in('token', oluTokenlar);
    }

    return new Response(
      JSON.stringify({
        gonderildi,
        toplam_android: androidTokenlari.length,
        toplam_ios: iosTokenlari.length,
        temizlenen_olu_token: oluTokenlar.length,
        hatalar: hatalar.slice(0, 3),
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[push-gonder]', e);
    return new Response(JSON.stringify({ hata: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
