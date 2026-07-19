'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'language-service';
const PORT = Number(process.env.PORT || 3000);

// All logs are structured JSON on stdout (12-factor), ready for
// Fluent Bit / Loki / ELK collection from the container runtime.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

const app = express();
app.use(express.json());
app.use(pinoHttp({
  logger,
  customProps: (req) => ({ requestId: req.headers['x-request-id'] || undefined })
}));

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', (req, res) => res.json({ ready: true, service: SERVICE_NAME }));

// --- Storefront localization --------------------------------------------
// EN is the source-of-truth language; every other locale is a full
// translation of the same key set. These are demo strings covering the
// storefront chrome (nav, search, hero, section headers); in production,
// swap `TRANSLATIONS` for a call to a TMS (Phrase, Lokalise, Crowdin, ...)
// or a machine-translation provider, cached behind the same shape.
const BASE = 'en';
const LANGUAGES = {
  en: { name: 'English',    nativeName: 'English',      flag: '🇬🇧', rtl: false },
  fr: { name: 'French',     nativeName: 'Français',     flag: '🇫🇷', rtl: false },
  es: { name: 'Spanish',    nativeName: 'Español',      flag: '🇪🇸', rtl: false },
  de: { name: 'German',     nativeName: 'Deutsch',      flag: '🇩🇪', rtl: false },
  it: { name: 'Italian',    nativeName: 'Italiano',     flag: '🇮🇹', rtl: false },
  pt: { name: 'Portuguese', nativeName: 'Português',    flag: '🇵🇹', rtl: false },
  nl: { name: 'Dutch',      nativeName: 'Nederlands',   flag: '🇳🇱', rtl: false },
  pl: { name: 'Polish',     nativeName: 'Polski',       flag: '🇵🇱', rtl: false },
  tr: { name: 'Turkish',    nativeName: 'Türkçe',       flag: '🇹🇷', rtl: false },
  ru: { name: 'Russian',    nativeName: 'Русский',      flag: '🇷🇺', rtl: false },
  hi: { name: 'Hindi',      nativeName: 'हिन्दी',        flag: '🇮🇳', rtl: false },
  ar: { name: 'Arabic',     nativeName: 'العربية',       flag: '🇸🇦', rtl: true  },
  ja: { name: 'Japanese',   nativeName: '日本語',        flag: '🇯🇵', rtl: false },
  zh: { name: 'Chinese',    nativeName: '中文',          flag: '🇨🇳', rtl: false },
  ko: { name: 'Korean',     nativeName: '한국어',        flag: '🇰🇷', rtl: false }
};

// Translation key set covers the storefront chrome that's visible before
// any product data loads: nav, search, sign-in, hero copy, section titles.
const TRANSLATIONS = {
  en: {
    'nav.oven': 'Oven', 'nav.menu': 'Menu', 'nav.loyalty': 'Crumb Club',
    'search.placeholder': 'Search the bakes…', 'account.signin': 'Sign in', 'cart.basket': 'Basket',
    'hero.kicker': 'Baked all day · Every colour of crumb',
    'hero.lede': 'Slow-fermented loaves, 27-layer croissants and candy-bright patisserie — pulled from the oven in waves through the day. Grab a basket; the sprinkles are already spinning.',
    'oven.title': 'Out of the oven', 'menu.title': 'The full spread',
    'loyalty.title': 'The Crumb Club',
    'loyalty.lede': 'Every euro earns a point. Points become free canelés, croissants and — at gold tier — a whole levain with your name piped on it. Sign in and start stacking.'
  },
  fr: {
    'nav.oven': 'Four', 'nav.menu': 'Carte', 'nav.loyalty': 'Club Miette',
    'search.placeholder': 'Cherchez une gourmandise…', 'account.signin': 'Connexion', 'cart.basket': 'Panier',
    'hero.kicker': 'Cuit toute la journée · Chaque couleur de miette',
    'hero.lede': "Pains à fermentation lente, croissants à 27 couches et pâtisseries éclatantes — sortis du four par vagues toute la journée. Prenez un panier ; les vermicelles tournent déjà.",
    'oven.title': 'Tout juste sorti du four', 'menu.title': 'La carte complète',
    'loyalty.title': 'Le Club Miette',
    'loyalty.lede': "Chaque euro dépensé rapporte un point. Les points se transforment en canelés, croissants gratuits et — au niveau or — un levain entier avec votre nom. Connectez-vous et commencez à cumuler."
  },
  es: {
    'nav.oven': 'Horno', 'nav.menu': 'Menú', 'nav.loyalty': 'Club Migaja',
    'search.placeholder': 'Busca un horneado…', 'account.signin': 'Iniciar sesión', 'cart.basket': 'Cesta',
    'hero.kicker': 'Horneado todo el día · Cada color de miga',
    'hero.lede': 'Panes de fermentación lenta, croissants de 27 capas y repostería de colores — recién salidos del horno en oleadas todo el día. Toma una cesta; los fideos de azúcar ya están girando.',
    'oven.title': 'Recién salido del horno', 'menu.title': 'La carta completa',
    'loyalty.title': 'El Club Migaja',
    'loyalty.lede': 'Cada euro suma un punto. Los puntos se convierten en canelés y croissants gratis y — en el nivel oro — una hogaza de masa madre entera con tu nombre. Inicia sesión y empieza a sumar.'
  },
  de: {
    'nav.oven': 'Ofen', 'nav.menu': 'Karte', 'nav.loyalty': 'Krümel-Club',
    'search.placeholder': 'Gebäck suchen…', 'account.signin': 'Anmelden', 'cart.basket': 'Korb',
    'hero.kicker': 'Den ganzen Tag frisch gebacken · Jede Krümelfarbe',
    'hero.lede': 'Langsam fermentierte Brote, 27-lagige Croissants und knallbunte Patisserie — den ganzen Tag über frisch aus dem Ofen. Nimm einen Korb; die Streusel drehen sich schon.',
    'oven.title': 'Frisch aus dem Ofen', 'menu.title': 'Die ganze Auswahl',
    'loyalty.title': 'Der Krümel-Club',
    'loyalty.lede': 'Jeder Euro bringt einen Punkt. Punkte werden zu kostenlosen Canelés, Croissants und — auf Gold-Stufe — einem ganzen Sauerteigbrot mit deinem Namen. Melde dich an und sammle los.'
  },
  it: {
    'nav.oven': 'Forno', 'nav.menu': 'Menù', 'nav.loyalty': 'Club Briciola',
    'search.placeholder': 'Cerca un lievitato…', 'account.signin': 'Accedi', 'cart.basket': 'Cesto',
    'hero.kicker': 'Sfornato tutto il giorno · Ogni colore di briciola',
    'hero.lede': 'Pani a lievitazione lenta, croissant a 27 strati e pasticceria coloratissima — sfornati a ondate tutto il giorno. Prendi un cesto; le codette sono già pronte.',
    'oven.title': 'Appena sfornato', 'menu.title': "L'assortimento completo",
    'loyalty.title': 'Il Club Briciola',
    'loyalty.lede': 'Ogni euro vale un punto. I punti diventano canelé e croissant gratis e — al livello oro — una pagnotta di lievito madre col tuo nome. Accedi e inizia a raccogliere punti.'
  },
  pt: {
    'nav.oven': 'Forno', 'nav.menu': 'Cardápio', 'nav.loyalty': 'Clube Migalha',
    'search.placeholder': 'Procure um assado…', 'account.signin': 'Entrar', 'cart.basket': 'Cesta',
    'hero.kicker': 'Assado o dia todo · Cada cor de migalha',
    'hero.lede': 'Pães de fermentação lenta, croissants de 27 camadas e confeitaria colorida — saindo do forno em ondas o dia todo. Pegue uma cesta; os confeitos já estão girando.',
    'oven.title': 'Recém-saído do forno', 'menu.title': 'O cardápio completo',
    'loyalty.title': 'O Clube Migalha',
    'loyalty.lede': 'Cada euro rende um ponto. Os pontos viram canelés e croissants grátis e — no nível ouro — um pão de fermentação natural com seu nome. Entre e comece a acumular.'
  },
  nl: {
    'nav.oven': 'Oven', 'nav.menu': 'Menu', 'nav.loyalty': 'Kruimelclub',
    'search.placeholder': 'Zoek een baksel…', 'account.signin': 'Inloggen', 'cart.basket': 'Mandje',
    'hero.kicker': 'De hele dag vers gebakken · Elke kruimelkleur',
    'hero.lede': 'Traag gefermenteerd brood, croissants met 27 laagjes en kleurrijk gebak — de hele dag in golven uit de oven. Pak een mandje; de spikkels draaien al.',
    'oven.title': 'Zo uit de oven', 'menu.title': 'Het volledige assortiment',
    'loyalty.title': 'De Kruimelclub',
    'loyalty.lede': 'Elke euro levert een punt op. Punten worden gratis canelés, croissants en — op goud-niveau — een heel desembrood met je naam erop. Log in en begin met sparen.'
  },
  pl: {
    'nav.oven': 'Piec', 'nav.menu': 'Menu', 'nav.loyalty': 'Klub Okruszka',
    'search.placeholder': 'Szukaj wypieku…', 'account.signin': 'Zaloguj się', 'cart.basket': 'Koszyk',
    'hero.kicker': 'Pieczone cały dzień · Każdy kolor okruszka',
    'hero.lede': 'Pieczywo na długim zakwasie, 27-warstwowe croissanty i kolorowe wypieki — prosto z pieca falami przez cały dzień. Weź koszyk; posypka już się kręci.',
    'oven.title': 'Prosto z pieca', 'menu.title': 'Pełna oferta',
    'loyalty.title': 'Klub Okruszka',
    'loyalty.lede': 'Każde euro to punkt. Punkty zamieniają się w darmowe canelé, croissanty, a na poziomie złotym — cały chleb na zakwasie z Twoim imieniem. Zaloguj się i zacznij zbierać.'
  },
  tr: {
    'nav.oven': 'Fırın', 'nav.menu': 'Menü', 'nav.loyalty': 'Kırıntı Kulübü',
    'search.placeholder': 'Bir lezzet ara…', 'account.signin': 'Giriş yap', 'cart.basket': 'Sepet',
    'hero.kicker': 'Gün boyu taze fırından · Her kırıntı renginde',
    'hero.lede': 'Yavaş mayalanmış ekmekler, 27 katlı kruvasanlar ve rengarenk pastalar — gün boyu dalgalar halinde fırından çıkıyor. Bir sepet al; şeker serpmeleri çoktan dönüyor.',
    'oven.title': 'Fırından yeni çıktı', 'menu.title': 'Tüm menü',
    'loyalty.title': 'Kırıntı Kulübü',
    'loyalty.lede': 'Her euro bir puan kazandırır. Puanlar ücretsiz canelé, kruvasan ve — altın seviyede — üzerinde adınız olan bir somun ekşi mayalı ekmeğe dönüşür. Giriş yapın ve puan biriktirmeye başlayın.'
  },
  ru: {
    'nav.oven': 'Печь', 'nav.menu': 'Меню', 'nav.loyalty': 'Клуб Крошка',
    'search.placeholder': 'Найти выпечку…', 'account.signin': 'Войти', 'cart.basket': 'Корзина',
    'hero.kicker': 'Выпекаем весь день · Каждый оттенок крошки',
    'hero.lede': 'Хлеб медленной ферментации, круассаны из 27 слоёв и яркая выпечка — весь день волнами прямо из печи. Берите корзину; посыпка уже кружится.',
    'oven.title': 'Только из печи', 'menu.title': 'Весь ассортимент',
    'loyalty.title': 'Клуб Крошка',
    'loyalty.lede': 'Каждое евро — это балл. Баллы превращаются в бесплатные канеле, круассаны, а на золотом уровне — целый хлеб на закваске с вашим именем. Войдите и начните копить.'
  },
  hi: {
    'nav.oven': 'ओवन', 'nav.menu': 'मेन्यू', 'nav.loyalty': 'क्रम्ब क्लब',
    'search.placeholder': 'बेक्ड चीज़ें खोजें…', 'account.signin': 'साइन इन करें', 'cart.basket': 'टोकरी',
    'hero.kicker': 'दिन भर ताज़ा बेक्ड · हर रंग का क्रम्ब',
    'hero.lede': 'धीमी किण्वन वाली ब्रेड, 27-परत क्रोइसां और रंग-बिरंगी पेस्ट्री — पूरे दिन लहरों में ओवन से बाहर आती हैं। एक टोकरी लें; स्प्रिंकल्स पहले से ही घूम रहे हैं।',
    'oven.title': 'अभी-अभी ओवन से बाहर', 'menu.title': 'पूरा मेन्यू',
    'loyalty.title': 'क्रम्ब क्लब',
    'loyalty.lede': 'हर यूरो एक पॉइंट कमाता है। पॉइंट्स मुफ़्त कैनेले, क्रोइसां और — गोल्ड स्तर पर — आपके नाम वाली एक पूरी लेवां ब्रेड बन जाते हैं। साइन इन करें और जमा करना शुरू करें।'
  },
  ar: {
    'nav.oven': 'الفرن', 'nav.menu': 'القائمة', 'nav.loyalty': 'نادي الفتات',
    'search.placeholder': 'ابحث عن مخبوزات…', 'account.signin': 'تسجيل الدخول', 'cart.basket': 'السلة',
    'hero.kicker': 'يُخبز طوال اليوم · بكل لون فتات',
    'hero.lede': 'أرغفة مخمّرة ببطء، كرواسون من 27 طبقة، وحلويات زاهية الألوان — تخرج من الفرن على دفعات طوال اليوم. خذ سلة؛ الرشات الملونة تدور بالفعل.',
    'oven.title': 'خرج للتو من الفرن', 'menu.title': 'القائمة الكاملة',
    'loyalty.title': 'نادي الفتات',
    'loyalty.lede': 'كل يورو يكسبك نقطة. تتحول النقاط إلى كانيليه وكرواسون مجانية، وعند المستوى الذهبي — رغيف عجين مخمّر كامل باسمك. سجّل الدخول وابدأ بالتجميع.'
  },
  ja: {
    'nav.oven': 'オーブン', 'nav.menu': 'メニュー', 'nav.loyalty': 'クラム倶楽部',
    'search.placeholder': '焼きたてを検索…', 'account.signin': 'サインイン', 'cart.basket': 'バスケット',
    'hero.kicker': '一日中焼きたて · あらゆる色のクラム',
    'hero.lede': 'ゆっくり発酵させたパン、27層のクロワッサン、色とりどりのパティスリー — 一日中波のようにオーブンから出てきます。バスケットを手に取ってください、スプリンクルはもう回っています。',
    'oven.title': '焼きたてほやほや', 'menu.title': '全メニュー',
    'loyalty.title': 'クラム倶楽部',
    'loyalty.lede': '1ユーロごとに1ポイント。ポイントは無料のカヌレやクロワッサンに、そしてゴールド会員なら名前入りのルヴァン全体になります。サインインして貯め始めましょう。'
  },
  zh: {
    'nav.oven': '烤炉', 'nav.menu': '菜单', 'nav.loyalty': '面包屑俱乐部',
    'search.placeholder': '搜索烘焙点心…', 'account.signin': '登录', 'cart.basket': '购物篮',
    'hero.kicker': '全天新鲜出炉 · 每一种面包屑色泽',
    'hero.lede': '慢发酵面包、27层可颂和色彩缤纷的糕点——整天一波波新鲜出炉。拿个篮子吧，糖粒已经开始转动了。',
    'oven.title': '刚出炉', 'menu.title': '全部菜单',
    'loyalty.title': '面包屑俱乐部',
    'loyalty.lede': '每花一欧元即可获得一分。积分可兑换免费可露丽、可颂——金卡等级还能兑换一整条印有您姓名的天然酵母面包。登录即可开始累积。'
  },
  ko: {
    'nav.oven': '오븐', 'nav.menu': '메뉴', 'nav.loyalty': '크럼 클럽',
    'search.placeholder': '베이커리 검색…', 'account.signin': '로그인', 'cart.basket': '장바구니',
    'hero.kicker': '하루 종일 갓 구운 · 모든 크럼의 색깔',
    'hero.lede': '천천히 발효한 빵, 27겹 크루아상, 화려한 패티스리 — 하루 종일 오븐에서 물결처럼 나옵니다. 바구니를 챙기세요, 스프링클은 이미 돌아가고 있어요.',
    'oven.title': '갓 나온 오븐', 'menu.title': '전체 메뉴',
    'loyalty.title': '크럼 클럽',
    'loyalty.lede': '1유로마다 1포인트가 적립됩니다. 포인트는 무료 카늘레, 크루아상으로, 골드 등급에서는 이름이 새겨진 르방 빵 한 덩이로 바뀝니다. 로그인하고 적립을 시작하세요.'
  }
};

const normalize = (code) => String(code || '').trim().toLowerCase().split('-')[0];
const known = (code) => Object.prototype.hasOwnProperty.call(LANGUAGES, code);

// GET /languages — supported locales with display names and flags
app.get(['/language', '/language/languages'], (req, res) => {
  res.json({
    base: BASE,
    languages: Object.entries(LANGUAGES).map(([code, l]) => ({ code, ...l }))
  });
});

// GET /language/translations?lang=fr — full key/value string table for a
// locale, falling back to English for any key the locale hasn't got yet.
app.get('/language/translations', (req, res) => {
  const lang = normalize(req.query.lang || BASE);
  if (!known(lang)) return res.status(400).json({ error: `Unknown language "${lang}"`, supported: Object.keys(LANGUAGES) });
  const translations = { ...TRANSLATIONS[BASE], ...(TRANSLATIONS[lang] || {}) };
  res.json({ lang, base: BASE, rtl: LANGUAGES[lang].rtl, translations });
});

// GET /language/translate?key=nav.oven&lang=fr  (also accepts POST with a JSON body)
function handleTranslate(req, res) {
  const src = req.method === 'POST' ? (req.body || {}) : req.query;
  const key = String(src.key || '').trim();
  const lang = normalize(src.lang || BASE);
  if (!key) return res.status(400).json({ error: 'A "key" is required' });
  if (!known(lang)) return res.status(400).json({ error: `Unknown language "${lang}"`, supported: Object.keys(LANGUAGES) });
  const text = (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS[BASE][key];
  if (!text) return res.status(404).json({ error: `Unknown translation key "${key}"` });
  req.log.info({ event: 'string_translated', key, lang }, 'translation served');
  res.json({ key, lang, text, rtl: LANGUAGES[lang].rtl });
}
app.get('/language/translate', handleTranslate);
app.post('/language/translate', handleTranslate);

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => logger.info({ event: 'service_started', port: PORT }, `${SERVICE_NAME} listening`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
    server.close(() => process.exit(0));
  });
}
