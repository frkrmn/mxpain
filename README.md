# Deribit Max Pain Scraper (Node.js + Puppeteer)

Deribit'in Open Interest By Strike Price grafiğindeki "Max Pain Price"
değerini BTC, ETH, SOL, XRP için çeker. Tarih seçicide her zaman mevcut
ayın son gününü seçer (örn. "31 Jul 26") ve sonucu `max_pain_data.json`
dosyasına ekler (append).

## 1. Kurulum

```bash
npm install
```

Bu, Puppeteer'ın kendi Chromium'unu otomatik indirir.

## 2. Selector'ları kalibre et (kritik — ilk çalıştırmadan önce yap)

Bu script deribit.com'un canlı DOM'una erişim olmadan yazıldı, bu yüzden
tarih seçici için kullanılan CSS/XPath selector'lar tahmine dayalı yedek
stratejiler içeriyor. Güvenmeden önce tarayıcıyı görünür modda çalıştır:

```bash
npm run debug
```

(bu `SCRAPER_HEADLESS=false node scraper.js` çalıştırır)

Şunları gözle kontrol et:
- Sağ üstteki tarih dropdown'ı (örn. "31 Jul 26 ⌄") doğru tıklanıyor mu?
- Listeden ayın son günü doğru seçiliyor mu?
- `max_pain_data.json` içinde `max_pain_value` gerçek bir sayı mı,
  yoksa `null` mü geliyor?

Bir adım tutmuyorsa `scraper.js` içindeki `SELECTORS` objesini güncelle.
Gerçek selector'ları bulmanın en hızlı yolu Chrome DevTools:

1. Sayfayı Chrome'da aç, tarih seçiciye sağ tıkla → "İncele" (Inspect)
2. Butonun/elemanın class'ını veya en yakın kararlı attribute'unu al
3. `SELECTORS.dateDropdownButton` / `SELECTORS.dateOptionListItem`
   listelerine ekle (birden fazla deneme sırayla denenir, ilk çalışan
   kullanılır)

## 3. Manuel çalıştırma

```bash
npm start
```

veya

```bash
node scraper.js
```

Çıktı `max_pain_data.json` dosyasına eklenir (üzerine yazmaz), örnek:

```json
[
  {
    "run_timestamp_utc": "2026-07-13T06:30:04.123Z",
    "target_expiry_label": "31 Jul 26",
    "results": [
      {
        "symbol": "BTC",
        "url": "https://www.deribit.com/statistics/BTC/Metrics/Options",
        "target_expiry_label": "31 Jul 26",
        "scraped_at_utc": "2026-07-13T06:30:11.456Z",
        "max_pain_raw_text": "Max Pain Price $1.15",
        "max_pain_value": 1.15,
        "date_selection_succeeded": true,
        "error": null
      }
    ]
  }
]
```

Loglar hem terminale hem `scraper.log` dosyasına yazılır.

## 4. Her gün 06:30 UTC'de zamanlama

Bu repoda hazır bir GitHub Actions workflow'u var:
`.github/workflows/scrape.yml`. Kendi sunucunda cron/systemd kurmak
istemiyorsan en kolay yol bu — aşağıdaki "GitHub Actions ile Çalıştırma"
bölümüne bak. Sunucunda çalıştırmak istersen aşağıdaki cron/systemd
seçenekleri de duruyor.

### Seçenek A — cron (kendi sunucunda, en basit)

```bash
crontab -e
```

Ekle (sunucunun yerel saat dilimi ne olursa olsun TZ=UTC ile zorla):

```cron
30 6 * * * TZ=UTC /usr/bin/node /tam/yol/deribit_scraper_node/scraper.js >> /tam/yol/deribit_scraper_node/cron.log 2>&1
```

### Seçenek B — systemd timer (Linux, daha sağlam)

`/etc/systemd/system/deribit-scraper.service`:
```ini
[Unit]
Description=Deribit Max Pain Scraper

[Service]
Type=oneshot
WorkingDirectory=/tam/yol/deribit_scraper_node
ExecStart=/usr/bin/node scraper.js
```

`/etc/systemd/system/deribit-scraper.timer`:
```ini
[Unit]
Description=Deribit Max Pain Scraper - her gün 06:30 UTC

[Timer]
OnCalendar=*-*-* 06:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now deribit-scraper.timer
```

### Seçenek C — node-cron (Node içinden, sürekli çalışan process olarak)

Eğer script'i cron yerine sürekli açık bir Node process olarak çalıştırmak
istersen `node-cron` paketini ekleyip şunu kullanabilirsin:

```bash
npm install node-cron
```

```js
const cron = require('node-cron');
const { run } = require('./scraper');

// '30 6 * * *' -> her gün 06:30, ama sunucu saatine göre çalışır!
// UTC'yi garanti etmek için process.env.TZ = 'UTC' ayarla.
process.env.TZ = 'UTC';
cron.schedule('30 6 * * *', () => {
  run().catch(console.error);
});
```

Ama üretim ortamında cron/systemd genelde daha güvenilir (process çökerse
otomatik yeniden başlamaya gerek yok, her gün taze bir çalıştırma olur).

## Notlar / Kısıtlamalar

- Bazı semboller için ayın son günü (örn. "31 Jul") vade listesinde
  olmayabilir (Deribit bazı vadeleri sadece belirli haftanın günlerinde
  açıyor olabilir). Bu durumda `date_selection_succeeded: false` döner ve
  script hata vermek yerine o an ekranda görünen vadeyi okumaya devam
  eder — çıktıda bu alanı kontrol et.
- Deribit sayfa yapısını değiştirirse `max_pain_value` `null` gelir;
  `scraper.log`'a bak ve kalibrasyon adımını tekrarla.
- Sunucuda (headless Linux) Puppeteer için gerekli sistem kütüphaneleri
  eksikse `npx puppeteer browsers install chrome` ve/veya
  `apt-get install -y libnss3 libatk-bridge2.0-0 ...` gerekebilir.

## 5. GitHub Actions ile Çalıştırma (repo aç, push et, bitti)

### 5.1 Yeni repo oluştur ve dosyaları push et

Terminalde proje klasöründeyken:

```bash
cd deribit_scraper_node
git init
git add .
git commit -m "ilk commit: deribit max pain scraper"
```

GitHub'da yeni, boş bir repo oluştur (README/gitignore EKLEME, çünkü
zaten var) — web arayüzünden "New repository" ya da `gh` CLI ile:

```bash
gh repo create deribit-max-pain-scraper --private --source=. --remote=origin
git push -u origin main
```

`gh` yoksa: GitHub'da elle repo oluştur, sonra:

```bash
git remote add origin https://github.com/KULLANICI_ADIN/deribit-max-pain-scraper.git
git branch -M main
git push -u origin main
```

### 5.2 Workflow otomatik olarak çalışır

`.github/workflows/scrape.yml` push edildiği anda GitHub Actions bunu
görür. Ekstra bir "secret" veya API key eklemene gerek yok — Puppeteer
kendi Chromium'unu Actions runner'ı üzerinde indirir, workflow gerekli
sistem kütüphanelerini `apt-get` ile kurar.

Ne yapıyor:
1. Her gün 06:30 UTC'de (`cron: "30 6 * * *"`) tetiklenir
2. Repoyu checkout eder, `npm ci` ile bağımlılıkları kurar
3. `node scraper.js` çalıştırır (headless)
4. Oluşan/güncellenen `max_pain_data.json` ve `scraper.log` dosyalarını
   otomatik olarak repoya commit + push eder (`github-actions[bot]` adına)
5. Hata olursa `scraper.log` ve `max_pain_data.json`'ı bir "artifact"
   olarak Actions çalıştırma sayfasına yükler, indirip inceleyebilirsin

### 5.3 Manuel test etmek

Cron'u beklemeden hemen test etmek için:

GitHub reposunda **Actions** sekmesi → **Deribit Max Pain Scraper**
workflow'u → sağ üstte **Run workflow** butonu → **Run workflow**
(bu, `workflow_dispatch` tetikleyicisi sayesinde çalışır).

Çalıştırma bitince **Actions** sekmesindeki run'a tıklayıp adım adım
logları (dahil olmak üzere `cat scraper.log` çıktısını) görebilirsin.

### 5.4 İzinler hakkında not

Workflow dosyasındaki `permissions: contents: write` satırı, Actions'ın
`max_pain_data.json` değişikliklerini repoya push edebilmesi için gerekli.
Eğer organizasyon/repo ayarlarında "Read and write permissions" Actions
için kapalıysa (Settings → Actions → General → Workflow permissions),
oradan "Read and write permissions" seçeneğini açman gerekir; aksi halde
push adımı `403` hatası ile başarısız olur.

### 5.5 Sonuçları nereden göreceksin

- Repo ana dalında `max_pain_data.json` her gün otomatik güncellenip
  commit geçmişinde birikir — dosyanın kendisini GitHub'da açıp
  görebilir, ya da repoyu `git pull` ile çekip yerelde okuyabilirsin.
- İstersen ileride bu JSON'u okuyup bir dashboard'a/Slack'e/Discord'a
  bildirim atan ikinci bir adım da workflow'a eklenebilir — istersen
  onu da birlikte kurarız.

