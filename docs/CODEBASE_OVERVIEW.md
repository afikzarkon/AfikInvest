# מדריך טכני מלא לפרויקט AfikInvest

מסמך זה סוקר **כל קובץ** בפרויקט: מה הוא מייצג, מה תפקידו, ופירוט מלא (עם נוסחאות ואלגוריתמים) של כל המערכות והחישובים שמומשו בו. הוא נכתב על ידי מעבר אוטומטי, קובץ-אחר-קובץ, על כל בסיס הקוד.

## מבנה המסמך

1. **קונפיגורציה, Build ו-Deploy** — package.json, render.yaml, vercel.json, .env.example, CI, README, תיקיית build, מסד הנתונים
2. **שרת (Backend)** — src/server.js וכל src/server/*, כולל אינטגרציית TASE ו-Yahoo Finance
3. **מנועי חישוב תיק ליבתיים (utils חלק 1)** — portfolioMath, portfolioStats, modifiedDietz, correlationAnalysis, rebalancing ועוד
4. **מנועי פיננסים/מס (utils חלק 2)** — cpiTax, dcfValuation, dividendAnalysis, taxLossHarvesting, bankSavingsFund ועוד
5. **קומפוננטות React (UI)** — src/App.js וכל src/components/*
6. **React Hooks** — כל src/hooks/*

כל קטע נכתב על ידי סריקה מלאה של הקובץ בפועל (לא תקציר שטחי) — כולל נוסחאות מדויקות, אלגוריתמים צעד-אחר-צעד, ומקרי קצה.

---

## חלק 1: קונפיגורציה, Build ו-Deploy

### `package.json`

**תפקיד**

קובץ המניפסט (manifest) המרכזי של פרויקט ה-Node.js/React: שם החבילה, גרסה, כל התלויות (dependencies/devDependencies), הסקריפטים להרצה/בנייה/בדיקה, והגדרות בנייה (ESLint, browserslist). זהו הקובץ שמגדיר איך `npm install`/`npm run <script>` מתנהגים, וגם המקור שממנו `npm ci` בונה את `package-lock.json`.

**לוגיקה מפורטת**

- `"name": "afikinvest"`, `"version": "0.1.1"`, `"private": true` (מונע פרסום בטעות ל-npm registry).
- `"proxy": "http://127.0.0.1:5000"` — הגדרת Create React App: בסביבת פיתוח (`npm start`, פורט 3000), כל בקשת API שלא נמצאת כקובץ סטטי מנותבת (proxy) אוטומטית לשרת ה-Node המקומי בפורט 5000 — כך שבמצב dev אין צורך ב-CORS או כתובת מוחלטת.
- **dependencies** (רצות גם ב-production, כולל שרת וגם קליינט מאחר שזה מונורepo אחד):
  - `@supabase/supabase-js` — קליינט Supabase, לתמיכה במסד PostgreSQL בענן (חלופה ל-SQLite, ראו `.env.example` ו-`DATABASE_URL`).
  - `@testing-library/*` — ספריות בדיקה (DOM, jest-dom, React, user-event) לבדיקות קומפוננטות.
  - `axios` — קליינט HTTP (בשימוש בקוד השרת/קליינט לביצוע קריאות חוץ).
  - `bcryptjs` — הצפנת סיסמאות (hashing) בצד השרת.
  - `better-sqlite3` — driver סינכרוני ל-SQLite, המקור ל-`data/stockview.db`.
  - `cheerio` — פרסינג HTML בסטייל jQuery, לשימוש ב-scraping (למשל TASE).
  - `cookie-parser` — middleware לפרסור עוגיות ב-Express (session/JWT cookies).
  - `cors` — middleware לניהול Cross-Origin Resource Sharing (חשוב כשה-frontend רץ ב-Vercel וה-API ב-Render, כתובות שונות).
  - `dotenv` — טעינת משתני סביבה מקובץ `.env` (ראו `.env.example`).
  - `exceljs` — יצירה/קריאה של קבצי Excel (ייתכן לייצוא דוחות).
  - `express` — פריימוורק שרת ה-API (`src/server.js`).
  - `http-proxy-middleware` — middleware ל-proxy בקשות HTTP (יכול לשמש בפריסה או בפיתוח).
  - `jsonwebtoken` — יצירה/אימות JWT לאימות משתמשים (`JWT_SECRET` ב-`.env.example`).
  - `jspdf` + `jspdf-autotable` — יצירת קבצי PDF (דוחות/טבלאות) בצד קליינט.
  - `pg` — driver ל-PostgreSQL (עבור מצב `DATABASE_URL`, חלופה ל-SQLite).
  - `puppeteer` — הפעלת דפדפן Chrome headless, לביצוע web-scraping (למשל שליפת מחירי TASE, ראו הערת `render.yaml`).
  - `react` / `react-dom` — גרסה 19.1.1 — ליבת ה-UI.
  - `react-scripts` — כלי הבנייה של Create React App (webpack/babel/jest עטופים).
  - `recharts` — ספריית גרפים לתצוגת נתוני תיק (עקומות שווי, פילוחים).
  - `web-vitals` — מדדי ביצועים (Core Web Vitals) לדוח ביצועים.
- **scripts**:
  - `"start": "react-scripts start"` — מריץ dev server (פורט 3000) עם hot reload.
  - `"dev": "concurrently -n api,web \"node src/server.js\" \"wait-on -t 90000 tcp:127.0.0.1:5000 && npm start\""` — מריץ **גם** את שרת ה-API (`src/server.js`, פורט 5000) **וגם** את שרת ה-React בו-זמנית, תוך שהצד ה-web מחכה (`wait-on`, עד 90 שניות timeout) שהשרת יעלה על הפורט לפני שהוא מתחיל — פותר race condition בעליית שני התהליכים.
  - `"render:build": "npm ci && npx puppeteer browsers install chrome"` — סקריפט build מיוחד לפלטפורמת **Render**: מתקין תלויות בדיוק לפי lockfile (`npm ci`), ואז מוריד/מתקין בינארי Chrome עבור Puppeteer (כי שירותי Render לא כוללים Chrome כברירת מחדל, וזה נדרש לscraping של TASE).
  - `"build": "react-scripts build"` — בונה את חבילת ה-production הסטטית לתיקיית `build/`.
  - `"test": "react-scripts test"` — מריץ את חבילת הבדיקות (Jest, עטוף על ידי CRA).
  - `"eject": "react-scripts eject"` — הסרת הפשטת CRA (חד-כיוונית, לא בשימוש כאן).
  - `"db:users": "node scripts/list-users.js"` — סקריפט תחזוקה/ניפוי שגיאות: מדפיס משתמשים שמורים במסד.
- **eslintConfig** — `extends: ["react-app", "react-app/jest"]` — כללי הלינטינג הסטנדרטיים של CRA.
- **browserslist** — קובע לאיזה דפדפנים ה-build מתאמת (transpile/polyfill) עבור production (`>0.2%`, `not dead`, `not op_mini all`) לעומת development (הגרסה האחרונה בלבד של Chrome/Firefox/Safari) — משפיע על הפלט של Babel/Autoprefixer.
- **devDependencies** — `concurrently` (הרצת מספר תהליכים במקביל, בשימוש בסקריפט `dev`), `wait-on` (המתנה לפורט/URL, גם הוא בשימוש ב-`dev`).

---

### `package-lock.json`

**תפקיד**

קובץ ננעל אוטומטית (821KB, כ-21,231 שורות) שמייצר `npm` בעצמו בעת `npm install`/`npm ci`. הוא "מקבע" את **עץ התלויות המלא** — כל תלות ותת-תלות, עם מספר גרסה מדויק, hash שלמות (integrity, בפורמט SHA-512) וכתובת ה-tarball המדויקת ממנה היא נמשכה — כדי שהתקנה על כל מכונה (מפתח מקומי, שרת CI, שרת פריסה כמו Render) תניב **עץ תלויות אחיד וחוזר-על-עצמו** (reproducible build), ולא רק גרסאות עומדות בתחום `^`/`~` שמוגדר ב-`package.json`. אין צורך לערוך אותו ידנית — הוא נוצר ומתעדכן אוטומטית בכל שינוי ל-`package.json` או הרצת `npm install`.

**לוגיקה מפורטת**

לא נקרא בשלמותו (נדרש רק לתאר תפקיד) — הקובץ מובנה סטנדרטית לפי סכימת `lockfileVersion` של npm: כותרת עם `name`/`version`/`lockfileVersion`, ואז מפת `packages` (לכל צומת ב-`node_modules` — הגרסה, `resolved` URL, `integrity` hash, ורשימת ה-dependencies הישירות שלו). `npm ci` (בשימוש ב-`render:build` וב-workflow ה-CI) מתקין **אך ורק** לפי מה שכתוב כאן (במקום לפתור טווחי גרסאות מחדש) — מה שמבטיח בנייה דטרמיניסטית וזהה בכל סביבה.

---

### `render.yaml`

**תפקיד**

קובץ קונפיגורציית **Infrastructure-as-Code** לפלטפורמת הפריסה **Render** — מגדיר את שירות ה-API (השרת Node/Express) שמופעל כשירות web נפרד מה-frontend (שיושב, לפי `.env.example` ו-`vercel.json`, על Vercel). הערת הפתיחה בקובץ מזהירה על מגבלת זיכרון בתוכנית החינמית (~512MB) שיכולה לגרום ל-OOM/הרג של תהליך Chrome (הדרוש ל-Puppeteer עבור scraping של TASE) — עם הנחיה לשדרג ל-Starter אם הבעיה חוזרת.

**לוגיקה מפורטת**

- `services:` — רשימת שירותים המנוהלים על ידי Render; כאן שירות בודד.
  - `type: web` — שירות HTTP ציבורי (בניגוד ל-worker/cron וכו').
  - `name: stockview-api` — שם השירות בדשבורד Render, ומשמש בחלק מכתובות ה-URL הדיפולטיביות.
  - `env: node` — סביבת ריצה Node.js (Render מתקין את גרסת Node המתאימה, מתייחסת ל-`engines` אם קיים ב-`package.json`, ואחרת ברירת מחדל).
  - `plan: free` — תוכנית התשלום — התוכנית החינמית (מוגבלת ב-RAM/CPU/"שינה" אחרי חוסר פעילות — הגורם לאזהרת ה-OOM בהערה).
  - `rootDir: .` — שורש הקוד לבנייה הוא שורש הריפו (אין תת-תיקייה נפרדת ל-backend).
  - `buildCommand: npm run render:build` — מריץ בעת deploy את הסקריפט המיוחד מ-`package.json` שמתקין תלויות (`npm ci`) **וגם** מתקין בינארי Chrome עבור Puppeteer (`npx puppeteer browsers install chrome`) — קריטי כי Render לא מגיע עם Chrome מובנה.
  - `startCommand: node src/server.js` — פקודת ההרצה בפועל של השירות בפרודקשן — מריצה ישירות את שרת ה-Express, ללא nodemon/PM2.
  - `envVars:` — משתני סביבה שמוגדרים אוטומטית בשירות:
    - `PUPPETEER_CACHE_DIR: /opt/render/.cache/puppeteer` — מכוון את מיקום המטמון של בינארי Chrome שהותקן ל-Puppeteer לתיקייה קבועה ב-Render, כדי ש-build לא יוריד את הבינארי מחדש כל פעם (וגם כדי שה-runtime ימצא אותו באותו מיקום ה-build שם אותו).

---

### `vercel.json`

**תפקיד**

קובץ קונפיגורציית פריסה לפלטפורמת **Vercel** — שם ה-frontend (חבילת ה-React הסטטית) מתארח. מגדיר כלל ניתוב (rewrite) יחיד, החיוני לתמיכה ב-**client-side routing** של אפליקציית Single-Page Application (SPA).

**לוגיקה מפורטת**

- `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]` — כלל regex יחיד שתופס **כל** נתיב (`/(.*)`  תואם כל URL אפשרי) ומפנה (rewrite, לא redirect — כתובת ה-URL בדפדפן לא משתנה) את כל הבקשות ל-`index.html`. זה נדרש כי אפליקציית React מנתבת בצד הקליינט (למשל React Router, אם קיים, או ניתוב פנימי) — בלי הכלל הזה, ריפרוש עמוד (F5) על נתיב פנימי (למשל `/portfolio`) היה מחזיר 404 מ-Vercel, כי אין קובץ סטטי בשם הזה בפועל; עם הכלל, Vercel מגיש בכל מקרה את `index.html`, ו-React עצמו "לוקח" מהנתיב ב-URL ומרנדר את התצוגה הנכונה.
- אין כאן `builds`/`env`/הגדרות נוספות — כל שאר ההגדרות (כמו `REACT_APP_API_URL`) מוגדרות ישירות בדשבורד של Vercel (ראו הערה ב-`.env.example`), לא בקובץ הזה.

---

### `.env.example`

**תפקיד**

קובץ תבנית (template) המתעד את **כל משתני הסביבה** שהאפליקציה (שרת + build של קליינט) עשויה להשתמש בהם, עם הערות מפורטות בעברית שמסבירות את המשמעות וההתנהגות של כל אחד. הקובץ עצמו לא נטען בפועל (מוגדר להחריג `.env` בפועל דרך `.gitignore`) — הוא רק מדריך למפתח/מפעיל כדי לדעת אילו משתנים להגדיר בסביבת ה-deploy בפועל (Render/Railway/VPS לשרת, Vercel לקליינט).

**לוגיקה מפורטת**

- כותרת ראשונה: "שרת (Render / Railway / VPS) — לא רץ ב-Vercel" — מבהיר חלוקת אחריות: השרת (Node/Express) לא רץ על Vercel (ל-Vercel יש רק את ה-build הסטטי).
  - `JWT_SECRET=שנה-אותי-למחרוזת-אקראית-ארוכה` — מפתח החתימה הסודי ל-JWT (אימות משתמשים); ערך placeholder שחייבים להחליף בסביבת production אמיתית.
  - `NODE_ENV=production` — מצב ריצה של Node — משפיע על אופטימיזציות (React, Express) ולוגים.
  - `TASE_API_KEY=` (מוער/כבוי כברירת מחדל) — מפתח ה-API הרשמי של **TASE Data Hub** ("Securities Prices - Online"). ההערה מסבירה התנהגות fallback חשובה: כשמוגדר — מחירי מניות ישראליות נשלפים דרך ה-API הרשמי; כשלא מוגדר, או שהמוצר עדיין ב-status PENDING בפורטל, האפליקציה **נופלת אוטומטית** חזרה לשיטת scraping עם Puppeteer, **בלי שום שינוי קוד נדרש** — כלומר יש לוגיקת feature-detection מובנית בשרת.
  - `CROSS_SITE_COOKIES=1` (מוער) — נדרש כשה-frontend על Vercel וה-API בדומיין אחר — מאפשר עוגיות cross-site (הכרחי לאימות מבוסס-session/cookie כשהדומיינים שונים; ה-SameSite/Secure flags צריכים תמיכה תואמת).
  - `DATABASE_URL=postgresql://...` (מוער) — Connection String למסד PostgreSQL בענן (Supabase/Neon) — כשמוגדר, **לא נדרש דיסק קבוע** ב-Render (שירות free tier ב-Render לא שומר דיסק בין deploys, כך שSQLite לוקאלי היה נמחק). הערה נוספת: אם החיבור ל-host מסוג `db.xxx.supabase.co` נכשל מ-Render בשל היעדר תמיכת IPv4 — יש להשתמש בכתובת URI של "Session Pooler" מהדשבורד של Supabase; ותווים מיוחדים בסיסמה (`@`, `#` וכו') חייבים URL-encoding.
  - `DATABASE_SSL=0` (מוער) — כיבוי אימות SSL, מיועד **רק** לבעיות SSL מקומיות (dev), לא ל-production.
  - `DATABASE_PATH=` (מוער) — מיקום קובץ SQLite מקומי; רלוונטי **רק** כשאין `DATABASE_URL` (כלומר אין Postgres בענן, והאפליקציה חוזרת לקובץ ה-SQLite הלוקאלי — זה מה ש-`data/stockview.db` מייצג).
- כותרת שנייה: "בניית React ב-Vercel (Settings → Environment Variables → Production)" — מבהיר שהמשתנה הבא מוגדר **בדשבורד Vercel**, לא בקובץ `.env` בפועל (כי Vercel לא קורא `.env` בזמן build של React אלא דרך ה-UI שלו).
  - `REACT_APP_API_URL=` (מוער) — כתובת בסיס ה-API (בלי סלאש בסוף, לדוגמה `https://xxx.onrender.com`) — הקידומת `REACT_APP_` נדרשת על ידי Create React App כדי שהמשתנה "יידלק" (inline) בזמן build לקוד הקליינט (למשל בשימוש ב-`apiBase.js`/`apiUrl()` שמופיע בכל ה-hooks שנבדקו לעיל).

---

### `.github/workflows/test.yml`

**תפקיד**

קובץ **GitHub Actions** — מגדיר workflow בשם "Test" שמריץ אוטומטית את חבילת הבדיקות (Jest, דרך `react-scripts test`) בכל push לענף `main` ובכל pull request — שכבת Continuous Integration (CI) שמונעת מיזוג קוד שבור.

**לוגיקה מפורטת**

- `name: Test` — שם ה-workflow כפי שמופיע בטאב Actions של GitHub.
- `on:` — טריגרים: `push` (רק ל-`branches: [main]`) ו-`pull_request` (כל PR, לכל branch יעד — אין הגבלת branches, כך שכל PR נבדק).
- `jobs.test`:
  - `runs-on: ubuntu-latest` — ריצה על runner לינוקס מנוהל של GitHub.
  - `env.PUPPETEER_SKIP_DOWNLOAD: 'true'` — משתנה סביבה שקובע לדלג על הורדת בינארי Chromium בעת `npm ci` (Puppeteer מוריד בדרך כלל Chromium משלו). ההערה בקוד מסבירה למה זה בטוח: הבדיקות (`src/server/taseScraper.test.js`) **מדמות (mock)** את Puppeteer באופן מלא — אין תלות אמיתית בדפדפן בבדיקות — כך שדילוג ההורדה שומר על ריצת CI מהירה ומונע כשלים לא-קשורים (כמו הורדת Chromium שנכשלת/מאטה).
  - שלבי (`steps`) ה-job:
    1. `actions/checkout@v4` — משיכת קוד המאגר.
    2. `actions/setup-node@v4` עם `node-version: 22` ו-`cache: npm` — התקנת Node גרסה 22 והפעלת caching אוטומטי של `~/.npm` (מקצר זמן ריצה בין הרצות).
    3. `npm ci` — התקנת תלויות בדיוק לפי `package-lock.json` (reproducible, מהיר יותר מ-`npm install` בסביבת CI).
    4. `npm test -- --watchAll=false` — מריץ את סוויטת הבדיקות של CRA/Jest **פעם אחת** ויוצא (בלי `--watchAll` — במצב watch רגיל ה-process היה נשאר תלוי וממתין לשינויי קבצים, מה שהיה תוקע את ה-CI לנצח).

---

### `README.md`

**תפקיד**

קובץ התיעוד הבסיסי של הריפו — במקרה הזה זהו ה-README ה**גנרי המוגדר כברירת מחדל על ידי Create React App** בעת יצירת הפרויקט (`npx create-react-app`), ולא תועד/הותאם מחדש לפרויקט afikinvest הספציפי. אין בו שום מידע ספציפי לתחום המניות/תיקים של האפליקציה.

**לוגיקה מפורטת**

- כותרת "Getting Started with Create React App" — מבהירה במפורש שהפרויקט "נוצר באמצעות" CRA.
- מתאר את הפקודות הסטנדרטיות של CRA:
  - `npm start` — מצב פיתוח, פורט 3000, hot reload.
  - `npm test` — מריץ את בדיקות ה-Jest במצב watch אינטראקטיבי (בשונה מ-CI, ראו `test.yml`, שמוסיף `--watchAll=false`).
  - `npm run build` — בונה גרסת production ל-`build/` (מוזער/minified, עם hash בשמות קבצים).
  - `npm run eject` — אזהרה מפורשת שזו פעולה **חד-כיוונית**: מוציאה את כל תצורת ה-build (webpack, Babel, ESLint וכו') מתוך `react-scripts` לריפו עצמו, מבטלת את ההפשטה של CRA.
- קישורים חיצוניים למידע נוסף: תיעוד CRA (code splitting, ניתוח גודל bundle, PWA, קונפיגורציה מתקדמת, deployment, ופתרון תקלה נפוצה "build fails to minify") ותיעוד React הכללי.
- אין כאן תיאור אדריכלות, API endpoints, סכימת מסד נתונים, או הסבר על afikinvest עצמו — לתיעוד כזה יש לפנות לקוד/הערות בפועל (כפי שמתועד במסמך הזה).

---

### `.gitignore`

**תפקיד**

מגדיר אילו קבצים/תיקיות **לא יעקבו** (ignored) על ידי Git — כלומר לא יתווספו לריפו, כדי לא להטביע קוד מקור עם artifacts שנוצרים אוטומטית, סודות, או קבצים גדולים/משתנים תדיר.

**לוגיקה מפורטת**

- `# dependencies`: `/node_modules` (כל תלויות ה-npm המותקנות, מותקנות מחדש מ-`package-lock.json` בכל build/CI), `/.pnp` ו-`.pnp.js` (שרידי תמיכה ב-Yarn Plug'n'Play, גם אם לא בשימוש בפועל בפרויקט).
- `# testing`: `/coverage` — פלט דוחות coverage שנוצר על ידי Jest (`react-scripts test --coverage`), נוצר מחדש בכל הרצה.
- `# production`: `/build` — תיקיית פלט ה-build הסטטי של `npm run build`; **לא** נשמר בגיט כי הוא artifact נגזר (deterministic) מהקוד המקורי — נוצר מחדש בכל deploy (Vercel מריץ בעצמו את `npm run build`).
- `# misc`: 
  - `/data/*.db`, `/data/*.db-shm`, `/data/*.db-wal` — קבצי מסד ה-SQLite המקומי (כולל קבצי ה-WAL/SHM הנלווים למנגנון Write-Ahead Logging) — **לא** נשמרים בגיט כי הם נתוני משתמשים אמיתיים (פרטיים, משתנים כל הזמן, ולפעמים אישיים/רגישים) ולא קוד. שים לב שהתבנית `*.db` וכו' תופסת גם את `data/stockview.db` שנמצא בפועל בעץ הקבצים המקומי — כלומר קובץ זה קיים על הדיסק אך אינו ולעולם לא יהיה מחויב (committed) לריפו.
  - `.DS_Store` — קובץ מטא-דאטה של macOS Finder.
  - `.env`, `.env.local`, `.env.development.local`, `.env.test.local`, `.env.production.local` — **כל** קבצי הסביבה בפועל (המכילים סודות אמיתיים כמו `JWT_SECRET`, `DATABASE_URL`) מוחרגים — רק `.env.example` (תבנית ללא סודות) נשאר בריפו.
  - `npm-debug.log*`, `yarn-debug.log*`, `yarn-error.log*` — קבצי לוג שגיאות שנוצרים על ידי מנהלי חבילות בעת כשל התקנה.

---

### `data/stockview.db`, `data/stockview.db-shm`, `data/stockview.db-wal`

**תפקיד**

שלושת הקבצים הבינאריים הללו הם קובץ מסד הנתונים **SQLite** המקומי בפועל של האפליקציה (דרך ה-driver `better-sqlite3` שמוגדר ב-`package.json`), המשמש כברירת המחדל כשלא הוגדר `DATABASE_URL` ל-Postgres בענן (ראו `.env.example`). זהו המקום שבו נשמרים בפועל (בסביבת dev/מקומית) כל נתוני המשתמשים: חשבונות, תיקי החזקות, תמונות-מצב יומיות/חודשיות, יעדי איזון-מחדש וכו' — כל מה שה-hooks במסמך זה (`usePortfolioData`, `usePortfolioSnapshots`, `useMonthlySnapshots`, `useRebalanceTargets`) שולפים/שומרים דרך ה-API.

**לוגיקה מפורטת** (תיאור בלבד — קבצים בינאריים, לא נקראו כטקסט)

- `stockview.db` (4KB) — קובץ מסד הנתונים הראשי עצמו: הסכימה (טבלאות) והשורות הנוכחיות הכתובות (committed) בפועל. הגודל הקטן (4KB) מרמז שרוב הנתונים "החמים" נכון לרגע זה נמצאים עדיין ב-WAL (ראו למטה) ולא נכתבו (checkpoint) חזרה לקובץ הראשי.
- `stockview.db-shm` (32KB) — קובץ "Shared Memory" של SQLite, המשמש לתיאום גישה בין-תהליכית (index לקובץ ה-WAL) כשמנגנון WAL (Write-Ahead Logging) מופעל. נוצר ומנוהל אוטומטית על ידי SQLite; אינו מכיל נתונים "אמיתיים" בפני עצמו.
- `stockview.db-wal` (כ-1.87MB) — קובץ ה-**Write-Ahead Log**: כל שינוי (INSERT/UPDATE/DELETE) שמתבצע נכתב תחילה לכאן (מהיר יותר מכתיבה ישירה לקובץ הראשי), ומועבר (checkpoint) לקובץ ה-`.db` הראשי בהמשך. הגודל הגדול היחסית (כ-1.87MB לעומת 4KB בקובץ הראשי) מצביע על נפח פעילות כתיבה מצטברת שעדיין לא עברה checkpoint מלא.
- שלושת הקבצים מוחרגים במפורש מ-Git (ראו `.gitignore`) — כי הם דאטה חי, פרטי, ומשתנה תדיר, לא קוד מקור; בסביבת production בענן (Render בלי דיסק קבוע) המסד המקומי הזה לא באמת שומר נתונים לצמיתות, ולכן `.env.example` ממליץ על `DATABASE_URL` (Postgres בענן) לפריסה אמיתית.

---

### תיקיית `build/`

**תפקיד**

תיקיית **פלט ה-build הסטטי בפרודקשן** שנוצרת אוטומטית על ידי `npm run build` (כלומר `react-scripts build`, Webpack מתחת למכסה המנוע) — זו התיקייה שנפרסת בפועל ל-Vercel (ראו `vercel.json`) ומוגשת לדפדפן. מוחרגת מ-Git (`/build` ב-`.gitignore`) כי היא artifact נגזר, לא קוד מקור — כל deploy מריץ build טרי מהקוד ב-`src/`.

**לוגיקה מפורטת** (תיאור מבני בלבד — לא נקראו קבצי static בודדים כטקסט)

- `index.html` — נקודת הכניסה ה-HTML היחידה של ה-SPA; מכיל תגי `<script>`/`<link>` שמצביעים לקבצי ה-JS/CSS המוזערים (עם hash בשם הקובץ, לשם cache busting). זהו הקובץ שאליו `vercel.json` מפנה כל נתיב (rewrite), כדי ש-client-side routing יעבוד גם בריפרוש עמוד.
- `asset-manifest.json` — מפה שמקשרת בין שמות קבצי המקור הלוגיים (למשל `main.js`) לבין שמות הקבצים המוזערים בפועל עם ה-hash (למשל `main.a3b9c98c.js`) — משמש כלים חיצוניים (כגון server-side rendering, אנליזה, או deployment scripts) לדעת אילו נכסים לטעון.
- `favicon.png`, `logo192.png`, `logo512.png`, `manifest.json`, `robots.txt` — נכסים סטטיים סטנדרטיים מ-CRA: אייקון האתר, אייקוני אפליקציה (PWA, גדלים שונים לפי דרישת מניפסט Web App), `manifest.json` עצמו (מטא-דאטה ל-"הוספה למסך הבית" בנייד), ו-`robots.txt` (הנחיות ל-web crawlers).
- `static/css/` — קובץ CSS מאוחד ומוזער יחיד (`main.0bf2a60e.css`, כ-57KB) + מפת מקור (`.css.map`, כ-104KB) לצורך debugging בכרום דרך DevTools מול הקוד המקורי.
- `static/js/` — קבצי ה-JavaScript המוזערים, מפוצלים ל-**chunks** (code splitting אוטומטי של Webpack, סביר להניח דרך `React.lazy`/`import()` דינמי בקוד המקור, כדי לא לטעון את כל האפליקציה בבת אחת):
  - `main.a3b9c98c.js` (כ-879KB) — ה-bundle הראשי (entry chunk).
  - `239.6450dd28.chunk.js` (כ-203KB), `453...`, `455...` (כ-138KB), `804...` (כ-129KB), `977...` (כ-29KB) — chunks נפרדים לפי route/feature (סביר: עמודי ניתוח, PDF/Excel export, וכו').
  - `955.20e2ab0f.chunk.js` — ה-chunk **הגדול ביותר** (כ-1.38MB) — כמעט בוודאות מכיל ספרייה כבדה (למשל `recharts`, `jspdf`+`jspdf-autotable`, או `exceljs`) שנטענת lazily רק כשצריך.
  - קבצי `.js.map` מקבילים לכל chunk — מפות מקור לניפוי שגיאות בפרודקשן (מאפשרות ל-DevTools להראות את קוד ה-JSX המקורי במקום את הקוד המוזער).
  - קבצי `.LICENSE.txt` — קרדיטים/רישיונות open-source שנדרשים על ידי כמה מהחבילות שנכללו באותו chunk (webpack מפריד אותם אוטומטית לקובץ נלווה כדי לא "לזהם" את קובץ ה-JS עצמו).
- בסך הכל: תיקיית `build/` היא תמונת-מצב מוזערת ומאוחדת (bundled) חד-פעמית של כל `src/` (כולל כל ה-hooks שתועדו במסמך זה) המוכנה להגשה סטטית ישירה מ-CDN, ללא שרת Node צד-קליינט בכלל.

## חלק 2: שרת (Backend)

# תיעוד טכני מפורט - שכבת השרת (Backend) של AfikInvest

---

### `src/server.js`

#### תפקיד
זהו קובץ הכניסה (entry point) של שרת ה-Express. הוא מרכיב את כל האפליקציה: יוצר את מופע ה-Express, מגדיר middleware גלובלי, "מתקין" (mount) את כל קבצי הראוטים השונים על ה-app, מאתחל את מסד הנתונים, ולבסוף מפעיל את השרת להאזנה על פורט. כל שאר קבצי `src/server/*Routes.js` הם מודולים שה-server.js מרכיב יחד - הקובץ הזה עצמו לא מכיל לוגיקת עסקים.

#### מערכות ולוגיקה מפורטת
1. **טעינת סביבה**: `require('dotenv').config()` בשורה הראשונה - טוען משתני סביבה מקובץ `.env` (כמו `JWT_SECRET`, `DATABASE_URL`, `TASE_API_KEY` וכו') לפני שכל מודול אחר נטען, כדי שכל הקוד שתלוי בהם (למשל `getJwtSecret()` ב-authRoutes) יראה אותם.
2. **בניית אפליקציית Express**:
   - `app.set('trust proxy', 1)` - מורה ל-Express לסמוך על header ה-`X-Forwarded-*` משכבת פרוקסי אחת (רלוונטי כשהשרת יושב מאחורי load balancer/reverse proxy כמו ב-Render/Heroku) - חשוב כדי ש-`req.ip` (המשמש את `rateLimit.js`) יזהה את כתובת ה-IP האמיתית של הלקוח ולא את כתובת הפרוקסי.
   - `app.use(cors({ origin: true, credentials: true }))` - מפעיל CORS עם `origin: true` (משקף כל origin שמגיע ומחזיר אותו ב-`Access-Control-Allow-Origin`, בניגוד ל-`*`) בשילוב עם `credentials: true` - הכרחי כדי לאפשר לדפדפן לשלוח cookies (ה-JWT) ב-cross-origin requests (למשל מ-Vercel לשרת ב-Render).
   - `app.use(express.json({ limit: '10mb' }))` - מפענח גוף בקשה כ-JSON, עם מגבלת גודל של 10MB (התיק כולל את כל ההיסטוריה/breakdown יכול להיות גדול).
   - `app.use(cookieParser())` - מפענח cookies (נדרש כדי לקרוא את `auth_token` שנשמר ב-authRoutes.js).
3. **הרכבת ראוטים ציבוריים (ללא תלות ב-DB)**: `mountQuotesRoutes`, `mountCpiRoutes`, `mountBenchmarkRoutes`, `mountSectorRoutes`, `mountAnalystRoutes`, `mountCorrelationRoutes`, `mountDividendRoutes`, `mountNewsRoutes`, `mountStockResearchRoutes` - כל אלו לא צריכים חיבור ל-store (הם עוסקים בנתוני שוק חיצוניים, לא בנתוני משתמש), ולכן מורכבים באופן סינכרוני לפני שה-DB מוכן.
4. **אתחול מסד הנתונים אסינכרוני**: `initDataStore()` (מ-dataStore.js) מוחזר כ-Promise. רק כשהוא מתמלא (`.then`):
   - מרכיבים את הראוטים שתלויים ב-`store`: `mountAuthRoutes`, `mountPortfolioRoutes`, `mountSnapshotRoutes`, `mountMonthlySnapshotRoutes`, `mountRebalanceRoutes`.
   - מדפיסים ללוג איזה סוג DB בשימוש (`store.kind === 'postgres' ? 'PostgreSQL...' : 'SQLite local file'`).
   - קוראים ל-`app.listen(PORT, ...)` כדי להתחיל להאזין. **חשוב**: אם אתחול ה-DB נכשל (`.catch`), מודפסת שגיאה ל-console והתהליך מסתיים עם `process.exit(1)` - השרת לא יתחיל להאזין אם אין DB תקין.
5. **PORT**: `Number(process.env.PORT) || 5000` - ברירת מחדל 5000 לפיתוח מקומי, אחרת לוקח מהסביבה (כמו ב-Render/Heroku שמגדירים PORT דינמית).

---

### `src/server/dataStore.js`

#### תפקיד
שכבת הפשטה (abstraction layer) מעל מסד הנתונים. מייצא פונקציה יחידה `initDataStore()` שמחליטה בזמן ריצה איזה backend DB להשתמש בו - **PostgreSQL** (אם `DATABASE_URL` מוגדר בסביבה, כמו ב-Supabase/Neon/Render) או **SQLite מקומי** (קובץ פיזי, לפיתוח או לשרת עם דיסק קבוע) - ומחזירה אובייקט `store` עם ממשק אחיד (אותן פונקציות async) ששאר קבצי הראוטים משתמשים בו בלי לדעת מהו ה-DB בפועל. זהו קובץ הליבה שמנהל את כל הסכמה (schema) והשאילתות.

#### מערכות ולוגיקה מפורטת

**בחירת מנוע - `initDataStore()`**:
```js
async function initDataStore() {
  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (url) return pgStore(url);
  return sqliteStore(openSqlite());
}
```
אם `DATABASE_URL` קיים ולא ריק → `pgStore`; אחרת → `sqliteStore` על גבי קובץ SQLite שנפתח/נוצר מקומית.

**נתיב SQLite - `getSqlitePath()` ו-`openSqlite()`**:
- הנתיב לקובץ ה-DB: `process.env.DATABASE_PATH` אם מוגדר, אחרת `data/stockview.db` בשורש הפרויקט (`path.join(__dirname, '..', '..', 'data', 'stockview.db')`).
- `openSqlite()` יוצר את תיקיית ה-data אם היא לא קיימת (`fs.mkdirSync(dir, { recursive: true })`), פותח DB עם `better-sqlite3`, מפעיל `journal_mode = WAL` (Write-Ahead Logging - מאפשר קריאות במקביל לכתיבה, פחות נעילות) ו-`foreign_keys = ON` (אכיפת מפתחות זרים - חשוב כדי ש-`ON DELETE CASCADE` יעבוד).
- יוצר (אם לא קיימות) 5 טבלאות:
  - `users(id, email UNIQUE COLLATE NOCASE, password_hash, created_at)` - `COLLATE NOCASE` מבטיח שהשוואת אימיילים היא case-insensitive ברמת ה-DB עצמו.
  - `user_portfolios(user_id PK/FK, payload TEXT, updated_at)` - שומר snapshot JSON שלם אחד לכל משתמש (המצב הקיים בפועל של תיק ההשקעות שלו, ב-SQLite).
  - `portfolio_snapshots(id, user_id, snapshot_date, total_value_ils, breakdown, created_at, UNIQUE(user_id, snapshot_date))` - snapshot יומי.
  - `portfolio_monthly_snapshots(id, user_id, snapshot_month, total_value_ils, breakdown, created_at, UNIQUE(user_id, snapshot_month))` - snapshot חודשי.
  - `rebalance_targets(user_id PK/FK, targets TEXT, updated_at)` - יעדי איזון תיק.

**ה-store של SQLite (`sqliteStore(db)`)** - מחזיר `{ kind: 'sqlite', ... }` עם הפונקציות הבאות (כולן `async` אבל למעשה סינכרוניות כי `better-sqlite3` הוא ספרייה חוסמת/סינכרונית עטופה ב-async):
- `findUserIdByEmail(email)` - `SELECT id FROM users WHERE email = ?`.
- `insertUser(email, passwordHash)` - `INSERT INTO users...` ומחזיר `{ id: Number(lastInsertRowid) }`.
- `findUserForLogin(email)` - שולף `id, email, password_hash` להשוואת סיסמה בהתחברות.
- `getPortfolioPayload(userId)` - שולף את שדה `payload` (מחרוזת JSON) או `null`.
- `upsertPortfolio(userId, payloadJson)` - `INSERT ... ON CONFLICT(user_id) DO UPDATE` (upsert אמיתי) - שומר תמיד שורה יחידה למשתמש, מעדכן `updated_at` לזמן נוכחי.
- `listUsersWithPortfolio()` - JOIN בין `users` ל-`user_portfolios` (LEFT JOIN) - מחזיר את כל המשתמשים + מתי כל אחד שמר לאחרונה תיק (משמש את `scripts/list-users.js`).
- `upsertPortfolioSnapshot(userId, snapshotDate, totalValueILS, breakdownJson)` - upsert לפי `(user_id, snapshot_date)` הייחודי.
- `listPortfolioSnapshots(userId)` - שולף לפי `ORDER BY snapshot_date ASC`, ו-`JSON.parse` את שדה ה-breakdown אם קיים.
- `upsertMonthlySnapshot` / `listMonthlySnapshots` - זהה בעקרון, לפי `snapshot_month`.
- `updateMonthlySnapshot(userId, snapshotMonth, totalValueILS, breakdownJson)` - **update-only, בכוונה**: משתמש ב-`UPDATE ... WHERE user_id=? AND snapshot_month=?` ולא ב-upsert - **לא יכול ליצור שורה חדשה**. מחזיר `result.changes > 0` (בוליאני שאומר אם משהו בפועל השתנה). ההערה בקוד מסבירה: זה מאפשר למשתמש "לתקן" חודש שכבר שמר (ה-route ה-PUT), אבל לא לייצר בדיעבד היסטוריה שרירותית שלא קיימת (בשונה מכלי seed לפיתוח בלבד).
- `deleteMonthlySnapshot(userId, snapshotMonth)` - `DELETE` לפי המפתח, מחזיר בוליאני הצלחה.
- `getRebalanceTargets(userId)` / `upsertRebalanceTargets(userId, targetsJson)` - ניהול היעדים לאיזון תיק, upsert סטנדרטי.

**ה-store של PostgreSQL (`pgStore(connectionString)`)** - מנגנון עשיר יותר, שמנהל **גם** את פריטי התיק בפועל (מניות, פנסיה, מזומן) בטבלאות מפורדות, לא רק snapshot JSON יחיד:
- יוצר `Pool` מ-`pg`, עם SSL מותנה: `DATABASE_SSL=0`/`'false'` מכבה SSL, אחרת `{ rejectUnauthorized: false }` (מקל על ספקי cloud עם תעודות self-signed).
- יוצר את אותן 4 הטבלאות הבסיסיות (`users`, `user_portfolios`, `portfolio_snapshots`, `portfolio_monthly_snapshots`, `rebalance_targets`) בסינטקס Postgres (`SERIAL`, `TIMESTAMPTZ`, `JSONB`), ומוסיף אינדקסים על `(user_id, snapshot_date)` ו-`(user_id, snapshot_month)`.
- **בנוסף**, יוצר 6 טבלאות "פריט-פר-שורה": `user_israeli_stocks`, `user_american_stocks`, `user_pension_funds`, `user_bank_balances`, `user_cash_funds`, `user_bank_savings_funds` - כל אחת `(id, user_id, sort_index, item JSONB, updated_at)`. כלומר, ב-Postgres כל פריט תיק (למשל מניה בודדת) הוא שורה נפרדת עם JSON גמיש בעמודת `item`, ולא כל התיק כ-blob אחד.
- **עמודות מחושבות (generated columns, `STORED`)**: לכל טבלת פריטים מוגדרות עמודות `GENERATED ALWAYS AS (...) STORED` שמחלצות שדות נפוצים מתוך ה-JSON (`item->>'stockName'`, `item->>'purchasePrice'` וכו') לעמודות טיפוסיות (TEXT/DOUBLE PRECISION/BIGINT/BOOLEAN), עם regex ולידציה (`~ '^-?\d+(\.\d+)?$'`) שמחזירה `NULL` אם השדה לא נומרי - כך שאילתות SQL עתידיות (חיפוש, סינון, מיון) יכולות להיות מהירות בלי לפרסר JSON בזמן ריצה. יש אינדקס נוסף על `(user_id, stock_name)` לטבלאות המניות.
- **`normalizeSnapshot(input)`**: פונקציה עוזרת שמבטיחה שכל אחד מ-6 המפתחות (`israeliStocks`, `americanStocks`, וכו') הוא מערך (גם אם ה-input הוא מחרוזת JSON, אובייקט, או פגום) - "מגן" מפני קלט לא תקין לפני כתיבה ל-DB.
- **`readItems(client, table, userId)`**: `SELECT item FROM <table> WHERE user_id=? ORDER BY sort_index ASC, id ASC` - שומר על סדר התצוגה כפי שהמשתמש ראה.
- **`writeItems(client, table, userId, items)`**: מוחק את כל שורות המשתמש (`DELETE ... WHERE user_id=?`) ואז מכניס את כל הפריטים מחדש עם `sort_index` = האינדקס במערך - כלומר, שמירה = "מחיקה מלאה + הכנסה מלאה" (לא UPDATE נקודתי), פר טבלה.
- **`getPortfolioPayload(userId)`**: קורא לקוח (`pool.connect()`) יחיד ומריץ ברצף (**לא** במקביל - יש הערה מפורשת בקוד "do not run concurrent queries on the same pg client") את 6 קריאות ה-`readItems`. אם יש נתונים מנורמלים (`hasNormalizedData` - סכום כל המערכים > 0) - מחזיר אותם כ-JSON. **תאימות לאחור**: אם אין נתונים בטבלאות המפורדות (משתמש ישן/ריק), פונה לטבלת ה-legacy `user_portfolios` ומחזיר את ה-payload הישן שלה כמו שהוא.
- **`upsertPortfolio(userId, payloadJson)`**: מנרמל את ה-snapshot, פותח **טרנזקציה** (`BEGIN`), כותב לכל 6 הטבלאות המפורדות (`writeItems`), **וגם** מעדכן את שורת ה-legacy `user_portfolios` (upsert) לצורך תאימות/בדיקה קלה, ולבסוף `COMMIT`. בכל שגיאה - `ROLLBACK` ומעבר השגיאה למעלה (`throw`), ותמיד `client.release()` ב-`finally`.
- **`listUsersWithPortfolio()`**: שאילתה מורכבת יותר מה-SQLite - משתמשת ב-`GREATEST(...)` על `updated_at` של שורת ה-legacy **וגם** על `MAX(updated_at)` מכל אחת מ-6 הטבלאות (subqueries), כדי לדעת מתי המשתמש שמר לאחרונה בכל מודל אחסון (הישן או החדש).
- שאר הפונקציות (`upsertPortfolioSnapshot`, `listPortfolioSnapshots`, `upsertMonthlySnapshot`, `listMonthlySnapshots`, `updateMonthlySnapshot`, `deleteMonthlySnapshot`, `getRebalanceTargets`, `upsertRebalanceTargets`) - מקבילות ישירות לגרסאות ה-SQLite אבל בסינטקס Postgres (`$1,$2...`, `::jsonb`, `::date`, `ON CONFLICT ... DO UPDATE`, `rowCount` במקום `changes`).

**קבוע מיוצא**: `PG_UNIQUE_VIOLATION = '23505'` - קוד השגיאה הסטנדרטי של Postgres להפרת אילוץ ייחודיות (UNIQUE constraint violation), משמש ב-`authRoutes.js` כדי לתפוס במפורש מקרה שבו שני בקשות register מקבילות מנסות ליצור את אותו אימייל (race condition).

---

### `src/server/authRoutes.js`

#### תפקיד
מנהל את כל מנגנון האימות (Authentication) של האפליקציה: הרשמה, התחברות, התנתקות, ובדיקת מי המשתמש המחובר. מבוסס JWT (JSON Web Token) הנשלח גם כ-HTTP-only cookie וגם ניתן להעברה כ-Bearer token ב-header. מייצא גם פונקציות עזר (`getJwtSecret`, `readAuthUserFromRequest`, `COOKIE_NAME`) ששאר קבצי הראוטים (portfolioRoutes, snapshotRoutes וכו') מייבאים כדי ליישם middleware של `requireAuth` בעצמם.

#### מערכות ולוגיקה מפורטת

**קונפיגורציה**:
- `COOKIE_NAME = 'auth_token'`.
- `BCRYPT_ROUNDS = 12` - מספר סבבי ה-hashing של bcrypt (12 הוא ברירת מחדל מאוזנת בין אבטחה למהירות).
- `JWT_TTL = '7d'` - תוקף הטוקן שבוע.

**`getJwtSecret()`**: קורא את `process.env.JWT_SECRET`. אם לא מוגדר/ריק - **בסביבת production זורק שגיאה** (`throw new Error('JWT_SECRET must be set in production')`) - מונע הרצת שרת production בלי secret אמיתי. בסביבת פיתוח מחזיר secret קבוע לדוגמה (`'stockview-dev-secret-change-me'`) כדי לאפשר עבודה מקומית בלי קונפיגורציה.

**ניהול Cookies**:
- `crossSiteCookies()`: בודק אם `CROSS_SITE_COOKIES` הוא `'1'` או `'true'` - flag לתמיכה בפריסה שבה ה-frontend וה-backend על domains שונים (למשל Vercel + Render).
- `cookieSharedAttributes()`: מחזיר `{ path: '/', sameSite: cross ? 'none' : 'lax', secure: cross || NODE_ENV==='production' }`. כלומר: אם cross-site - `sameSite: 'none'` (חובה לפי דפדפנים מודרניים כדי לאפשר cookie ב-cross-origin) ואז `secure: true` הכרחי (דפדפנים דוחים `SameSite=None` בלי `Secure`). אחרת - `sameSite: 'lax'` (הגנת CSRF בסיסית) ו-`secure` רק ב-production.
- `cookieOptions()`: מוסיף `httpOnly: true` (חוסם גישת JS מהדפדפן - הגנת XSS) ו-`maxAge: 7*24*60*60*1000` (7 ימים, תואם ל-JWT_TTL).
- `clearCookieAttrs()`: אותם attributes בלי `httpOnly`/`maxAge` - נדרש כי `res.clearCookie` צריך את אותן attributes (path/sameSite/secure) שהוגדרו ביצירה כדי שהדפדפן בפועל ימחק את ה-cookie.

**ולידציה**:
- `normalizeEmail(email)`: `trim().toLowerCase()`.
- `isValidEmail(email)`: אורך בין 5-254 תווים + regex בסיסי `^[^\s@]+@[^\s@]+\.[^\s@]+$` (לא RFC מלא, אבל תופס את המקרים הנפוצים).

**חילוץ טוקן מהבקשה**:
- `extractBearerToken(req)`: קורא header `Authorization`/`authorization`, מחלץ עם regex `^Bearer\s+(.+)$/i` את הטוקן שאחרי "Bearer ".
- `readAuthUserFromRequest(req, jwtSecret)`: הפונקציה המרכזית - מעדיפה **Bearer token** על פני cookie (`const token = bearerToken || cookieToken`), מאמתת עם `jwt.verify` (שיזרוק שגיאה אם הטוקן לא תקין/פג תוקף - הקריאה **לא** תופסת שגיאות, מטילה את זה על הקורא), ומחזירה `{ id: payload.sub, email: payload.email, tokenSource: 'bearer'|'cookie' }`. אם אין טוקן בכלל - מחזירה `null` (לא שגיאה).

**`mountAuthRoutes(app, store)`**:
- מגדיר שני rate limiters (ראו rateLimit.js): `loginLimiter` (חלון 15 דקות, מקסימום 10 בקשות, הודעת שגיאה בעברית) ו-`registerLimiter` (חלון שעה, מקסימום 10). **חשוב**: אלו שני מופעים נפרדים (state נפרד) - ניצול יתר בהתחברות לא חוסם הרשמה מאותו לקוח (נבדק ב-authRoutes.test.js).

- **`GET /api/auth/me`**: קורא ל-`readAuthUserFromRequest`. אם אין authUser - מחזיר `{ user: null }`. אם יש - `{ user: { id, email } }`. אם `jwt.verify` זרק שגיאה (טוקן לא תקין/פג) - ה-`catch` **מנקה את ה-cookie** (`res.clearCookie`) ומחזיר `{ user: null }` (לא שגיאת 401) - כך שה-frontend מטפל בזה כ"לא מחובר" בצורה חלקה בלי צורך בטיפול שגיאות מיוחד.

- **`POST /api/auth/register`** (עם `registerLimiter`):
  1. מנרמל email, קורא password כמחרוזת.
  2. ולידציה: email תקין (400 אם לא: `'כתובת אימייל לא תקינה'`), סיסמה מינימום 8 תווים (400: `'הסיסמה חייבת להכיל לפחות 8 תווים'`).
  3. בודק אם המייל קיים כבר (`store.findUserIdByEmail`) - אם כן, 409 `'כתובת האימייל כבר רשומה במערכת'`.
  4. מבצע `bcrypt.hashSync(password, 12)`.
  5. מנסה `store.insertUser(email, passwordHash)`. אם נכשל עם קוד `SQLITE_CONSTRAINT_UNIQUE` או `PG_UNIQUE_VIOLATION` (23505) - **race condition guard**: מישהו הספיק להירשם עם אותו מייל בין הבדיקה (שלב 3) להכנסה בפועל - מחזיר 409 שוב (לא 500). כל שגיאה אחרת - נזרקת מעלה.
  6. יוצר JWT עם `{ sub: user.id, email: user.email }`, תוקף 7 ימים.
  7. שולח cookie (`res.cookie`) **וגם** מחזיר את הטוקן בגוף התשובה (`{ user, token }`) - כדי לתמוך גם בלקוחות שמעדיפים Bearer token (למשל localStorage דרך `authToken.js`) וגם ב-cookie.
  8. סטטוס 201.
  9. כל שגיאה לא צפויה - מלוגגת (`console.error`) ומחזירה 500 `'שגיאת שרת'`.

- **`POST /api/auth/login`** (עם `loginLimiter`):
  1. אם אין email או password - 400 `'יש למלא אימייל וסיסמה'`.
  2. `store.findUserForLogin(email)` - אם אין שורה, **או** `bcrypt.compareSync(password, row.password_hash)` נכשל - 401 `'אימייל או סיסמה שגויים'` (הודעה גנרית אחת גם למקרה "אין משתמש" וגם למקרה "סיסמה שגויה", כדי לא לחשוף אילו אימיילים רשומים - user enumeration protection).
  3. אם עבר - יוצר JWT, שולח cookie, מחזיר `{ user, token }` בסטטוס 200 (ברירת מחדל).

- **`POST /api/auth/logout`**: פשוט מוחק את ה-cookie ומחזיר `{ ok: true }` - אין ניהול session בצד שרת (JWT הוא stateless), כך שאין "רשימה שחורה" - הטוקן פשוט לא נמחק בפועל, רק ה-cookie בדפדפן הלקוח נעלם.

**ייצוא**: `mountAuthRoutes`, `getJwtSecret`, `COOKIE_NAME`, `readAuthUserFromRequest` - ה-3 האחרונים משמשים כתשתית שכל שאר קבצי ה-routes (portfolioRoutes, snapshotRoutes, monthlySnapshotRoutes, rebalanceRoutes) מייבאים כדי לבנות בעצמם middleware `requireAuth` זהה בקונספט.

---

### `src/server/authRoutes.test.js`

#### מה הטסטים בודקים
טסט Jest (`@jest-environment node`) שמקים שרת Express אמיתי (`app.listen(0)`) עם `mountAuthRoutes` ו-store מדומה (`jest.fn()`), ומבצע בקשות HTTP אמיתיות באמצעות מודול `http` המובנה (Jest לא חושף `fetch` גלובלי כברירת מחדל). מתמקד **רק** בהתנהגות ה-rate limiting:
- לאחר 10 ניסיונות login כושלים (401), הניסיון ה-11 מחזיר **429** עם הודעת שגיאה ו-header `Retry-After`.
- לאחר 10 ניסיונות register (409 - אימייל תמיד "כבר קיים"), הניסיון ה-11 מחזיר **429**.
- **בדיקה קריטית**: הפעלת ה-rate limit על login לא חוסמת register מאותו client - מוכיח ששני ה-limiters (`loginLimiter`, `registerLimiter`) הם state נפרד לחלוטין (כל אחד ב-Map משלו).

---

### `src/server/portfolioRoutes.js`

#### תפקיד
ניהול "תיק ההשקעות" של המשתמש - שמירה וטעינה של כל הנתונים (מניות ישראליות, מניות אמריקאיות, קרנות פנסיה, יתרות בנק, קרנות נאמנות, קרנות חיסכון בנקאיות) כ-blob JSON יחיד לכל משתמש. זהו ה-API המרכזי שה-frontend קורא אליו כדי לטעון/לשמור את מצב התיק המלא.

#### מערכות ולוגיקה מפורטת
- **`requireAuth` middleware**: מוגדר מקומית (זהה בקונספט לזה שב-snapshotRoutes/monthlySnapshotRoutes/rebalanceRoutes) - קורא ל-`readAuthUserFromRequest(req, getJwtSecret())`. אם אין authUser - 401 `'נדרשת התחברות'`. אם `jwt.verify` זרק (טוקן לא תקין/פג) - נתפס ב-`catch` ומחזיר 401 `'פג תוקף או טוקן לא תקין'`. אם עבר - קובע `req.user = { id, email }` וקורא ל-`next()`.
- **`emptyPortfolio()`**: פונקציית עזר שמחזירה אובייקט עם 6 המערכים הריקים - ברירת מחדל למשתמש חדש שאין לו payload שמור.
- **`GET /api/portfolio`** (requireAuth):
  1. `store.getPortfolioPayload(req.user.id)` - מחזיר מחרוזת JSON או `null`.
  2. אם `null` - מחזיר `emptyPortfolio()`.
  3. אחרת `JSON.parse(raw)`, ולכל אחד מ-6 השדות בודק `Array.isArray(...)` ומחזיר את המערך או `[]` (הגנה מפני payload פגום/חלקי היסטורי) - **אף פעם לא סומך על התוכן הגולמי כמו שהוא**.
  4. כל שגיאה (JSON.parse נכשל, שגיאת DB) - 500 `'שגיאת שרת'` (ללא לוג - שים לב שאין `console.error` כאן, בשונה מקבצים אחרים).
- **`PUT /api/portfolio`** (requireAuth):
  1. בונה `snapshot` מתוך `req.body`, שוב עם `Array.isArray(...) : []` הגנתי לכל שדה - מבטיח שרק מבנה מוכר וקוהרנטי נשמר ל-DB, לא כל מה שהלקוח שלח.
  2. `JSON.stringify(snapshot)` ושומר עם `store.upsertPortfolio(req.user.id, payload)`.
  3. מחזיר `{ ok: true }`; שגיאה → 500.
- **הערה חשובה**: הראוט הזה **לא מחשב** מחירים/שווי בעצמו - הוא רק מאחסן את מה ששלח ה-client (שכבר חישב הכל בצד לקוח בעזרת מחירים חיים). זה תפקיד טהור של persistence.

---

### `src/server/quotesRoutes.js`

#### תפקיד
מרכז את כל ה-routes של ציטוטי מחירים "בזמן אמת": מניות ישראליות (TASE, דרך scraping), מניות אמריקאיות ושער חליפין דולר/שקל (דרך Yahoo Finance). זהו הקובץ שמממש את הלוגיקה של "נסה API רשמי → נסה scraping עם Puppeteer → נסה fallback עם axios/cheerio → החזר ערך ישן מהקאש → החזר null" - שרשרת עמידות (resilience) מרובת-שכבות למחיר מניה ישראלית ספציפית.

#### מערכות ולוגיקה מפורטת

**`taseInFlight` (Map)**: מפה של `stockId -> Promise` - מונעת בקשות scraping כפולות/מקבילות לאותו stockId (בקשות בוטות/מספר טאבים בו-זמנית) - כל הבקשות שמגיעות בזמן שיש כבר scraping פעיל לאותו stockId "רוכבות" על אותו Promise (`await existingInFlight`).

**`errMessage(err)`**: פונקציית עזר שמחלצת הודעת שגיאה קריאה מכל טיפוס קלט (string/Error/undefined) - למטרות לוג.

**`fetchTaseQuote(stockId, req)`** - הליבה של כל השרשרת:
1. **שלב 1 - API רשמי**: אם `isTaseApiConfigured()` (יש `TASE_API_KEY`) - מנסה `fetchTaseQuoteFromApi(stockId)` (taseApi.js). אם מצליח - כותב לקאש (`writeCachedTaseQuote`) ומחזיר. אם נכשל - **לא זורק שגיאה**, רק מלוגג אזהרה וממשיך לשלב 2 (scraping) - כי ה-API הרשמי כרגע ב-status "PENDING" אישור ב-TASE, וזה מצב זמני צפוי.
2. **שלב 2 - Puppeteer עם ניסיון חזרה (retry) אחד**: בונה URL (`https://market.tase.co.il/he/market_data/security/{id}/major_data`), מנסה `scrapeTaseWithPuppeteer(taseUrl)`. אם התוצאה **לא** "usable" (`isUsableTasePayload`) - זורק שגיאה מכוונת כדי להיכנס לבלוק ה-`catch` הפנימי, שמנסה **שוב פעם אחת** (`retrying once`) - הערה בקוד: כשלים חד-פעמיים/זמניים (timeout גבולי, עומס RAM) הם נפוצים בסביבות עם משאבים מוגבלים (כמו tier חינמי ב-Render), וניסיון שני תופס חלק גדול מהמקרים האלה בעלות זמן קטנה.
3. אם ה-retry גם נותן payload לא usable - מלוגג אזהרה (עם `_debugTextSnippet` - מה שהדפדפן בפועל ראה, כדי לאבחן bot-block/מבנה שונה) וזורק שגיאה - יוצא מבלוק ה-try החיצוני.
4. אם usable - מלוגג הצלחה (**גם** בהצלחה, לא רק בכישלון! - כדי לתפוס מקרה שבו הregex "תפס" שדה שגוי אך עדיין נראה תקין מספרית), כותב קאש, מחזיר.
5. **שלב 3 - Fallback עם axios+cheerio**: אם Puppeteer נכשל (אחרי הretry), מנסה `scrapeTaseFallbackWithAxios(taseUrl)`. אם התוצאה usable - קאש + return. אחרת - זורק.
6. **שלב 4 - Stale cache**: אם גם ה-fallback נכשל - `readStaleTaseQuote(stockId)` (מחזיר את הערך האחרון מהקאש **בלי בדיקת TTL**) - אם קיים, מוחזר עם אזהרת לוג.
7. **שלב 5 - Debug mode**: אם `req.query.debug === '1'`/`'true'` - מחזיר אובייקט עם `_debug: { stockId, taseUrl, puppeteerError, fallbackError }` - שימושי לפתרון תקלות ידני.
8. **שלב 6 - מוצא אחרון**: מחזיר `{ currentPrice: null, changePercent: null }` - "נכשל בעד חן" (graceful degradation), לעולם לא קורס.

**`mountQuotesRoutes(app)`**:
- **`GET /api/israeli-stock/:id`**:
  1. מוודא ש-`stockId` הוא מספרים בלבד (`/^\d+$/`) - 400 `{ error: 'invalid stock id' }` אחרת.
  2. `readCachedTaseQuote(stockId)` - קאש בן 60 שניות (TASE_CACHE_TTL_MS ב-taseScraper.js) - אם יש, מחזיר ישירות, בלי scraping.
  3. אם יש in-flight request פעיל לאותו id - "רוכב" עליו (`await existingInFlight`). אם הוא נכשל - מנסה stale cache, אחרת מחזיר nulls.
  4. אחרת יוצר Promise חדש (`fetchTaseQuote`), רושם אותו ב-`taseInFlight`, ומוחק אותו מה-Map ב-`finally` (בהצלחה או כישלון) - כך שהבקשה הבאה תיצור בקשה חדשה.
- **`GET /api/american-stock/:symbol`**: מוודא symbol לא ריק (400 אחרת), קורא ל-`getYahooPayload(symbol)` (yahooQuotes.js). בכישלון - `{ currentPrice: null, changePercent: 0 }` (שים לב: 0, לא null, ל-changePercent - שונה מהמניה הישראלית).
- **`GET /api/exchange-rate`**: קורא `getYahooPayload('USDILS=X')` - סימול Yahoo לשער דולר/שקל. מחזיר `{ rate: payload.currentPrice }`, או `{ rate: null }` בכישלון.
- **`GET /api/exchange-rate/:date`**: מוודא פורמט `YYYY-MM-DD` (400 אחרת). קורא `fetchYahooHistoricalRateForDate('USDILS=X', date)` - מחזיר את השער ההיסטורי + התאריך **בפועל** שנמצא (יכול להיות אחורה, אם היום המבוקש היה שבת/חג ואין נתון). מטרתו: מילוי אוטומטי של שדה שער חליפין בטופס "הוספת מניה" לפי תאריך רכישה.

---

### `src/server/quotesRoutes.test.js`

#### מה הטסטים בודקים
מוקים (`jest.mock`) של `taseScraper` ו-`yahooQuotes` (כדי לא לגעת ב-Puppeteer/network אמיתיים), מקים שרת Express אמיתי. `beforeEach` מאפס בסיס-ברירת-מחדל: "הכל נכשל, שום דבר בקאש" (בגלל `resetMocks:true` של CRA). בודק:
- `GET /api/israeli-stock/:id` מסרב id לא מספרי (400); מנסה puppeteer ואז axios fallback ונכשל בעד חן ל-`{currentPrice:null, changePercent:null}`; מגיש stale cache כשקיים; מגיש cached value בלי לקרוא לscraper כלל; מצליח דרך puppeteer בלבד בלי fallback; **עושה retry פעם אחת ל-puppeteer** על כישלון חולף לפני fallback; רק אחרי 2 כישלונות puppeteer עובר ל-axios fallback.
- `GET /api/american-stock/:symbol` מסרב symbol ריק (400); נכשל בעד חן ל-`{currentPrice:null, changePercent:0}`; מחזיר נתונים אמיתיים בהצלחה.
- `GET /api/exchange-rate` נכשל בעד חן ל-`{rate:null}`; מצליח.
- `GET /api/exchange-rate/:date` מסרב פורמט לא תקין (400); נכשל בעד חן; מחזיר rate+date היסטורי אמיתי כולל **את יום המסחר בפועל שנמצא** (לא בהכרח התאריך המבוקש); מחזיר null כשלא נמצא יום מסחר מתאים.

---

### `src/server/rateLimit.js`

#### תפקיד
מגביל קצב בקשות (rate limiter) מינימלי, פשוט, **בזיכרון** - בלי תלות חיצונית (כמו Redis), מיועד לתהליך שרת יחיד בלבד (לא multi-instance). מיוצא כ-factory function `createRateLimiter` שמייצר middleware של Express לפי חלון-זמן קבוע (fixed window).

#### מערכות ולוגיקה מפורטת
```js
function createRateLimiter({ windowMs, max, message, keyFn }) {
  const hits = new Map(); // key -> { count, resetAt }
  ...
}
```
- **`resolveKey(req)`**: אם `keyFn` הועבר, משתמש בו; אחרת ברירת מחדל `req.ip`.
- **`middleware(req, res, next)`**:
  1. מחשב `key` ו-`now = Date.now()`.
  2. אם אין entry קיים לאותו key, **או** `now >= entry.resetAt` (החלון הישן פג) - יוצר entry חדש `{ count: 0, resetAt: now + windowMs }` - זהו אלגוריתם "fixed window": כל key מקבל חלון-זמן משלו שמתחיל בפעם הראשונה שהוא נתפס, ומתאפס לגמרי כשעובר windowMs מהשימוש הראשון בחלון (לא "sliding window").
  3. מגדיל `entry.count += 1`.
  4. אם `entry.count > max` - חוסם: מחשב `retryAfterSec = Math.ceil((entry.resetAt - now) / 1000)`, מגדיר header `Retry-After`, ומחזיר **429** עם `{ error: message || 'יותר מדי בקשות, נסה שוב מאוחר יותר' }`.
  5. אחרת קורא ל-`next()`.
- **`middleware.reset = () => hits.clear()`**: פונקציית עזר שמאפסת את כל המצב - שימושית לטסטים (לא נראה בשימוש בקוד production).

---

### `src/server/rateLimit.test.js`

#### מה הטסטים בודקים
בונה `req`/`res` מדומים ידנית (לא HTTP אמיתי) עם `makeReqRes(ip)`. בודק:
- בקשות מתחת למגבלה עוברות עם `next()` ולא נוגעות ב-status.
- מעבר המגבלה - status 429, גוף עם ה-`message` שהועבר, וקיים header `Retry-After`.
- **בידוד לקוחות**: שני IP שונים נספרים בנפרד (אחד לא חוסם את השני).
- **פקיעת חלון**: עם `jest.useFakeTimers()` - אחרי שחוסם, מקדם את הזמן ב-1001ms (מעבר לwindowMs=1000) ומראה שהמונה מתאפס ומרשה בקשה נוספת.
- `middleware.reset()` מנקה את כל המצב הנצבר.

---

### `src/server/snapshotRoutes.js`

#### תפקיד
ניהול **snapshots יומיים** של שווי התיק הכולל (בש"ח) לכל משתמש - שורה אחת ליום קלנדרי. זהו הבסיס לניתוח היסטורי אמיתי (עקומת הון/equity curve, drawdown מקסימלי, תנודתיות/Sharpe אמיתיים, השוואה למדדי ייחוס) - לפני זה האפליקציה לא שמרה היסטוריה בכלל, רק "עכשיו" מול "מחיר קנייה". השרת **לא מחשב** את השווי בעצמו - ה-frontend (שיש לו את המחירים החיים) מחשב אותו ושולח, והשרת רק שומר.

#### מערכות ולוגיקה מפורטת
- **`requireAuth`**: אותו middleware בדפוס זהה לקבצים האחרים (מגדיר `req.user`, 401 אם אין authUser או טוקן לא תקין).
- **`todayDateString()`**: `new Date().toISOString().slice(0,10)` - תאריך "היום" בפורמט `YYYY-MM-DD`, **מחושב בצד שרת** (לא נסמך על הלקוח) - כך ששמירות חוזרות באותו יום מעדכנות את אותה שורה (upsert) ולא יוצרות כפילויות.
- **`isValidDateString(s)`**: ולידציה של פורמט `YYYY-MM-DD` בעזרת regex.
- **`POST /api/portfolio-snapshot`** (requireAuth):
  1. `totalValueILS = Number(body.totalValueILS)` - חייב להיות מספר סופי (`Number.isFinite`) ולא שלילי - 400 `'totalValueILS לא תקין'` אחרת.
  2. `snapshotDate` - אם הלקוח שלח תאריך תקין (`isValidDateString(body.date)`), משתמש בו; אחרת נופל ל-`todayDateString()`. (זה מאפשר במקרים מיוחדים תאריך מפורש, אבל ברוב הזמן זה "היום").
  3. `breakdown` - אם קיים ו-הוא אובייקט, ממיר ל-JSON string; אחרת `null`.
  4. `store.upsertPortfolioSnapshot(userId, snapshotDate, totalValueILS, breakdown)` - upsert לפי `(user_id, snapshot_date)`.
  5. מחזיר `{ ok: true, date: snapshotDate }`; שגיאה → לוג + 500.
- **`GET /api/portfolio-snapshots`** (requireAuth): `store.listPortfolioSnapshots(req.user.id)` - מחזיר `{ snapshots: [...] }` ממוין לפי תאריך עולה; שגיאה → לוג + 500.

---

### `src/server/monthlySnapshotRoutes.js`

#### תפקיד
נקודות ביקורת **חודשיות** (checkpoints) של שווי התיק + breakdown לפי קטגוריה - פעולה **נפרדת ומכוונת** מה-snapshots היומיים (שמזינים equity curve/drawdown/השוואת benchmark אוטומטית). זהו לצורך "checkpoint" איטי ומפורש שהמשתמש בוחר לבצע בעצמו (בקצב שהוא רוצה), ואז דפדפן/משווה בהיסטוריה (סעיף "מעקב חודשי" ב-PortfolioAnalysisView.js).

#### מערכות ולוגיקה מפורטת
- **`requireAuth`**: זהה בדפוס לקבצים האחרים.
- **`currentMonthString()`**: `new Date().toISOString().slice(0,7)` - "החודש הזה" בפורמט `YYYY-MM`, **מחושב בצד שרת** (לא נסמך על הלקוח) - כך ששמירות חוזרות באותו חודש מעדכנות אותה שורה.
- **`MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/`**: ולידציית פורמט חודש קפדנית (חודש בין 01-12 בלבד).
- **`POST /api/portfolio-monthly-snapshot`** (requireAuth): שומר לחודש **הנוכחי בלבד** (מחושב שרת, לא מהלקוח). מוודא `totalValueILS` תקין (400 אחרת), ממיר breakdown ל-JSON אם קיים, `store.upsertMonthlySnapshot`, מחזיר `{ ok: true, month }`.
- **`POST /api/portfolio-monthly-snapshot/manual`** (requireAuth): מאפשר למשתמש **לבחור בעצמו** חודש עבר שהחמיץ (זרימת "➕ הוספה ידנית"):
  1. מוודא `month` תואם `MONTH_KEY_RE` (400 `'פורמט חודש לא תקין'` אחרת).
  2. מוודא `month <= currentMonthString()` - **לא ניתן להוסיף שמירה לחודש עתידי** (400 `'לא ניתן להוסיף שמירה לחודש עתידי'`) - השוואת מחרוזות בפורמט `YYYY-MM` עובדת נכון כי הפורמט אחיד ומסודר לקסיקוגרפית = כרונולוגית.
  3. שאר הולידציות זהות, `store.upsertMonthlySnapshot(userId, month, ...)`.
- **`GET /api/portfolio-monthly-snapshots`** (requireAuth): מחזיר `{ snapshots }` ממוין.
- **`PUT /api/portfolio-monthly-snapshot/:month`** (requireAuth) - "ערוך" בהיסטוריה: מוודא פורמט חודש, מוודא `totalValueILS`, קורא ל-**`store.updateMonthlySnapshot`** (**לא** upsert - עדכון בלבד, ראו ההערה בdataStore.js) - אם לא עודכן כלום (`updated === false`, כלומר החודש לא היה קיים כבר) - **404** `'לא נמצאה שמירה חודשית לחודש זה - ניתן לערוך רק חודשים שכבר נשמרו'`. זה ההבדל המכוון בין ה-route הזה ל-`manual` למעלה: `manual` יכול ליצור שורה חדשה, `PUT` יכול רק לעדכן קיימת.
- **`DELETE /api/portfolio-monthly-snapshot/:month`** (requireAuth): מוודא פורמט חודש, `store.deleteMonthlySnapshot` - אם לא נמצא/נמחק כלום - 404 `'לא נמצאה שמירה חודשית לחודש זה'`.

---

### `src/server/sectorRoutes.js`

#### תפקיד
מציאת סקטור/תעשייה (sector/industry) עבור מניות אמריקאיות - עבור תצוגת "פיזור לפי סקטור" בתיק. נתונים ציבוריים (לא תלויי משתמש), ולכן ללא צורך באימות. עובד ב-batch (הלקוח שולח רשימת סימולים בבקשה אחת) ומיישם קאש כפול (הצלחה/כישלון) עם TTL שונה לכל אחד.

#### מערכות ולוגיקה מפורטת
- **`CACHE_TTL_MS = 24h`**: לתשובה מוצלחת - סקטור של חברה כמעט לא משתנה מיום ליום.
- **`FAILURE_CACHE_TTL_MS = 5min`**: לכישלון - ברוב המקרים כישלונות (429, שגיאות רשת) הם זמניים, כך שיש טעם לנסות שוב מהר יותר.
- **`cache` (Map)** ו-**`inFlight` (Map)** - שני מפות module-level (משותפות בין כל הבקשות, לא per-request).
- **`MAX_SYMBOLS_PER_REQUEST = 30`** - תואם לגודל תיק ריאלי, ומגן מהתעללות (abuse) בבקשה עצומה.
- **`getCachedSector(symbol)`**:
  1. בודק קאש - אם קיים ולא עבר ה-TTL הרלוונטי (מותאם ל-`isFailure`), מחזיר אותו ישירות.
  2. אם יש בקשה in-flight לאותו symbol - מצטרף אליה (לא יוצר בקשה כפולה).
  3. אחרת יוצר Promise חדש: קורא ל-`fetchYahooAssetProfile(symbol)`. בהצלחה - כותב לקאש עם `isFailure: false`. בכישלון - מלוגג אזהרה, כותב fallback `{ sector: null, industry: null }` עם `isFailure: true` (**גם כישלון נשמר בקאש** - כדי לא לתקוף את Yahoo שוב ושוב תוך 5 דקות).
  4. רושם ב-`inFlight`, ומוחק משם ב-`finally`.
- **`mountSectorRoutes(app)`**:
  - **`POST /api/stock-sectors`** (לא GET - כי רשימת symbols יכולה להיות ארוכה מנוח ל-query string, וזו "batch resolve" ולא "fetch resource by id"):
    1. מנקה ומנרמל: `[...new Set(symbols.map(s => trim().toUpperCase()).filter(Boolean))]` - הסרת כפילויות, טרימינג, אחידות case, הסרת ערכים ריקים.
    2. חותך ל-30 הראשונים (`.slice(0, MAX_SYMBOLS_PER_REQUEST)`).
    3. אם הרשימה ריקה - `{ sectors: {} }`.
    4. `Promise.all` על כל הסימולים המנוקים (קריאה מקבילה - אבל בפועל כל אחד עובר ב-throttling queue המשותף שב-yahooQuotes.js).
    5. בונה מפת תוצאות `{ SYMBOL: {sector, industry} }`.
    6. כישלון גורף (לא צריך לקרות בפועל כי כל symbol מטופל בנפרד) - 502 `'לא ניתן היה למשוך נתוני סקטור'`.

---

### `src/server/rebalanceRoutes.js`

#### תפקיד
ניהול "יעדי איזון תיק" (rebalancing targets) - האחוז שהמשתמש רוצה שיוקצה לכל קטגוריה בתיק (מניות ישראליות/אמריקאיות/פנסיה/קרנות מזומן/בנק). נתונים אישיים לתכנון, ולכן דורש אימות ונשען per-user, בדיוק כמו portfolioRoutes.js.

#### מערכות ולוגיקה מפורטת
- **`REBALANCE_CATEGORIES = ['israeli', 'american', 'pension', 'cashFunds', 'bank']`** - חמש הקטגוריות המוגדרות מראש (לא רשימה דינמית).
- **`requireAuth`**: אותו דפוס תקני.
- **`normalizeTargets(body)`**: לכל קטגוריה, `Number(body?.[key])` - אם `Number.isFinite(value) && value >= 0`, שומר את הערך; אחרת מגדיר `0`. **תמיד** מחזיר את כל 5 המפתחות (אף פעם לא חסר מפתח, גם אם הלקוח לא שלח את הכל).
- **`GET /api/rebalance-targets`** (requireAuth): `store.getRebalanceTargets(userId)` - מחזיר `{ targets: targets || null }` (null אם המשתמש לא הגדיר עדיין יעדים).
- **`PUT /api/rebalance-targets`** (requireAuth): מנרמל את הבקשה עם `normalizeTargets`, שומר JSON עם `store.upsertRebalanceTargets`, מחזיר `{ ok: true, targets }` (הערכים המנורמלים בפועל, לא מה שהלקוח שלח - כדי שה-frontend יראה בדיוק מה נשמר).
- **הערה**: אין ולידציה שהסכום הכולל = 100% - זה מוטל על ה-frontend/UX, לא מאולץ בשרת.

---

### `src/server/dividendRoutes.js`

#### תפקיד
נתוני דיבידנד למניות אמריקאיות: הן תחזית קדימה (yield, payout ratio, תאריך תשלום הבא, תאריך ex-dividend) והן היסטוריית תשלומים ממשית. **מוזג גם נתוני דיווח קרוב (earnings)** - תאריך דוח רבעוני הבא, אומדני EPS/רווח - כי Yahoo מחזיר את שני הסטים (דיבידנד+earnings) יחד באותה קריאת `calendarEvents`, כך שפיצול לשני routes נפרדים היה כפול קריאה יקרה (שני slots בתור המוגבל).

#### מערכות ולוגיקה מפורטת
- **`SUMMARY_CACHE_TTL_MS = 6h`** (תואם analystRoutes.js).
- **`HISTORY_CACHE_TTL_MS = 24h`**: תשלומי דיבידנד עבר **לא משתנים לעולם**.
- **`FAILURE_CACHE_TTL_MS = 5min`**.
- **`MAX_SYMBOLS_PER_REQUEST = 30`**.
- שני זוגות Map נפרדים: `summaryCache`/`summaryInFlight` ו-`historyCache`/`historyInFlight` - **נשמרים ומטופלים בנפרד** כי מקורם שונה (מודול quoteSummary לעומת public chart endpoint).
- **`isValidDateString(s)`**: פורמט `YYYY-MM-DD`.
- **`getCachedDividendSummary(symbol)`**: זהה בדיוק לדפוס `getCachedSector` - קאש + inFlight + fallback עם כל השדות `null` (`dividendRate, dividendYieldPercent, payoutRatio, exDividendDateEpoch, nextDividendDateEpoch, earningsDateEpoch, isEarningsDateEstimate, epsEstimateAverage, revenueEstimateAverage`) בכישלון.
- **`getCachedDividendHistory(symbol, fromDateStr)`**: מפתח קאש `${symbol}:${fromDateStr || 'default'}` - כי היסטוריה יכולה להיבקש עם "from" שונה. בכישלון מחזיר **מערך ריק** (לא null) - "כשל סימבול בודד, לא כל ה-batch", כמו correlationRoutes.js.
- **`POST /api/dividend-data`**:
  1. מנקה/מנרמל/חותך symbols כמו בקבצים האחרים.
  2. `from = isValidDateString(body.from) ? body.from : undefined`.
  3. אם רשימה ריקה - `{ dividends: {} }`.
  4. עבור כל symbol - **מקביל** (`Promise.all` פנימי) בין `getCachedDividendSummary` ל-`getCachedDividendHistory`, ומיזוג ל-`{ ...summary, history }`.
  5. בונה `{ dividends: { SYMBOL: {...summary, history} } }`.
- **הערה**: בשונה מ-sectorRoutes/analystRoutes, אין `try/catch` חיצוני סביב ה-`Promise.all` הראשי כי כל שגיאה כבר נתפסת בתוך `getCachedDividendSummary`/`getCachedDividendHistory` עצמם.

---

### `src/server/dividendRoutes.test.js`

#### מה הטסטים בודקים
מוק ל-`yahooQuotes`. בודק: מערך symbols ריק → `{}`; מיזוג נכון של summary+history לאובייקט אחד עם מפתח `history`; כישלון בשני הפטצ'ים (summary+history) לא מפיל את הבקשה - מחזיר את כל השדות כ-`null`/`[]`; ניקוי/UPPER-CASE/דה-דופ של symbols עם קאש per-symbol (בקשה שנייה לא קוראת שוב ל-Yahoo); העברת `from` תקין ל-`fetchYahooDividendHistory`, והתעלמות מ-`from` לא תקין (`undefined` מועבר במקום); הגבלת batch ל-30 סימולים.

---

### `src/server/analystRoutes.js`

#### תפקיד
המלצות אנליסטים למניות אמריקאיות: קונצנזוס (rating), מחירי מטרה (price targets), והיסטוריית שינויי דירוג (upgrade/downgrade) - דרך אותו endpoint `quoteSummary` של Yahoo שגם sectorRoutes.js משתמש בו, ולכן חולק את אותו מנגנון אימות crumb/cookie (yahooCrumb.js) ואת אותו דפוס batched-POST + per-symbol cache.

#### מערכות ולוגיקה מפורטת
- **`CACHE_TTL_MS = 6h`**: קונצנזוס אנליסטים לא זז דקה-לדקה.
- **`FAILURE_CACHE_TTL_MS = 5min`**.
- **`MAX_SYMBOLS_PER_REQUEST = 30`**.
- **`getCachedAnalystData(symbol)`**: אותו דפוס קאש+inFlight מדויק. fallback בכישלון: `{ recommendationKey: null, numberOfAnalystOpinions: null, targetMeanPrice: null, targetHighPrice: null, targetLowPrice: null, currentTrend: null, upgradeHistory: [] }`.
- **`POST /api/analyst-recommendations`**: אותו דפוס ניקוי/דה-דופ/UPPER/חתך-30 → `Promise.all(getCachedAnalystData)` → מפת `{ SYMBOL: data }`. כישלון גורף (לא צריך לקרות בפועל) → 502 `'לא ניתן היה למשוך נתוני אנליסטים'`.

---

### `src/server/newsRoutes.js`

#### תפקיד
כותרות חדשות אחרונות למניות אמריקאיות, דרך endpoint חיפוש ציבורי של Yahoo (**לא** דורש crumb/cookie, בשונה מ-sectorRoutes/analystRoutes) - נתונים ציבוריים, ללא אימות משתמש. הקאש כאן קצר בהרבה משאר הקבצים (30 דקות בלבד) כי חדשות רגישות-לזמן, בשונה מסיווג סקטור שכמעט לא משתנה.

#### מערכות ולוגיקה מפורטת
- **`CACHE_TTL_MS = 30min`**, **`FAILURE_CACHE_TTL_MS = 5min`**, **`MAX_SYMBOLS_PER_REQUEST = 30`**, **`NEWS_PER_SYMBOL = 10`** (כמות כתבות פר symbol).
- **`getCachedNews(symbol)`**: אותו דפוס קאש+inFlight; בכישלון - מחזיר **מערך ריק** (לא אובייקט עם שדות null, בגלל שהתשובה עצמה היא מערך) ומסמן `isFailure: true`.
- **`POST /api/stock-news`**: ניקוי/UPPER/דה-דופ/חתך-30, `Promise.all(getCachedNews)`, מחזיר `{ news: { SYMBOL: [...] } }`. אם רשימה ריקה - `{ news: {} }` בלי לקרוא לכלום.

---

### `src/server/newsRoutes.test.js`

#### מה הטסטים בודקים
רשימה ריקה → `{}` בלי קריאה ל-Yahoo; batch/dedup/UPPER-CASE (בדיקה ש-`aapl`/`AAPL`/`' msft '` הופכים ל-2 קריאות בלבד: `AAPL`, `MSFT`); סימבול שנכשל מחזיר `[]` בלי להפיל את שאר ה-batch; קאש per-symbol חוסך קריאה חוזרת; הגבלת batch ל-30.

---

### `src/server/correlationRoutes.js`

#### תפקיד
שליפת סגירות יומיות היסטוריות עבור מספר סימולים אמריקאיים בבקשה אחת - משמש את ה-frontend לחישוב מטריצת קורלציה בין ההחזקות (`src/utils/correlationAnalysis.js`). נתונים ציבוריים, קאש אגרסיבי (6 שעות) - סגירה היסטורית מאתמול לא משתנה.

#### מערכות ולוגיקה מפורטת
- **`CACHE_TTL_MS = 6h`** (תואם benchmarkRoutes.js).
- **`MAX_SYMBOLS_PER_REQUEST = 30`**.
- **`isValidDateString(s)`**: פורמט `YYYY-MM-DD`.
- **`getCachedHistory(symbol, fromDateStr)`**: מפתח קאש `${symbol}:${fromDateStr||'default'}`. קורא ל-`fetchYahooHistoricalCloses(symbol, fromDateStr)`. בכישלון - מלוגג אזהרה, מחזיר **מערך ריק** - "מניה בודדת שנכשלת (delisted/renamed) לא מכבה את כל מטריצת הקורלציה לשאר התיק" (הערה בקוד). **שים לב**: בניגוד ל-sectorRoutes, **אין** קאש-כישלון (isFailure) כאן - כישלון פשוט לא נכתב לקאש בכלל, כך שהניסיון הבא יבצע fetch מחדש בלי TTL מיוחד.
- **`POST /api/stock-price-history`**: ניקוי/UPPER/דה-דופ/חתך-30, `from` אופציונלי מוודא, `Promise.all(getCachedHistory)`, מחזיר `{ history: { SYMBOL: [{date, close}, ...] } }`. רשימה ריקה → `{ history: {} }`.

---

### `src/server/correlationRoutes.test.js`

#### מה הטסטים בודקים
רשימה ריקה → `{}`; batch/dedup/UPPER (2 קריאות בלבד לApAAPL+MSFT מ-3 variants); symbol שנכשל מחזיר `[]` בלי להפיל batch; קאש per-symbol (אין קריאה חוזרת); העברת/דחיית `from`; הגבלת 30 symbols. הערה בטסט: הקאש הוא module-level ונשמר בין טסטים בקובץ, כך שטסטים משתמשים בsymbols שונים (`GOODTICKER`/`BADTICKER`) כדי לא להתנגש עם קאש מטסט קודם.

---

### `src/server/cpiRoutes.js`

#### תפקיד
מקור נתונים למדד המחירים לצרכן (CPI) הישראלי, דרך ה-API הציבורי של הלמ"ס (הלשכה המרכזית לסטטיסטיקה, CBS). המדד מתפרסם רק פעם בחודש (ה-15 לחודש, לחודש הקודם), כך שאין טעם למשוך אותו בכל טעינה - נשמר בקאש בזיכרון ומתרענן פעם ביום (למקרה שפורסם מדד חדש) או לפי דרישה מפורשת (חודש ספציפי שלא נשלף בעבר).

#### מערכות ולוגיקה מפורטת
- **`CBS_BASE_URL = 'https://api.cbs.gov.il/index/data/price'`**, **`CPI_SERIES_ID = '120010'`** (קוד סדרה "מדד המחירים לצרכן - כללי").
- **`CACHE_TTL_MS = 24h`**.
- **`createCpiCache()`**: יוצר קאש **per-mount** (לא module-level גלובלי) - `monthIndexCache` (Map של `YYYY-MM -> value`, בלי תפוגה כי מדד עבר שפורסם לא משתנה) ו-`latestIndexCache` (אובייקט `{month, value, fetchedAt}` עם תפוגה). ה-per-mount נועד לאפשר להריץ עותקים מבודדים (כמו בטסטים) בלי לדלוף state בין ריצות.
- **`parseCbsResponse(data)`**: מפרסר את מבנה התגובה **האמיתי** של ה-API (מאומת מול שרת חי): `data.month` הוא מערך סדרות, ולכל סדרה `date[]` עם `{year, month, currBase: {value}}` (year/month נפרדים, לא תאריך string; הערך בתוך `currBase`, לא במערך). בונה `monthKey = "${year}-${String(month).padStart(2,'0')}"` ומחזיר `[{month, value}, ...]`.
- **`fetchCbsSeries({startPeriod, endPeriod, last})`**: קורא ל-CBS עם `axios.get`, פרמטרים `{id: CPI_SERIES_ID, format:'json', lang:'en', download:'false'}` (+ startPeriod/endPeriod/last אם קיימים), header `User-Agent: 'afikinvest-app/1.0'` (**חובה** לפי תיעוד הלמ"ס), timeout 10 שניות. אם מתקבלות 0 שורות - מלוגג אזהרה עם snippet של התגובה הגולמית (עוזר לאבחון אם המבנה שונה מהצפוי או שהפרמטרים לא תקינים).
- **`getIndexForMonth(cache, monthKey)`**: אם `monthKey` בקאש - מחזיר ישירות. אחרת בונה `period = "${month}-${year}"` (**חשוב**: פורמט `mm-yyyy`, **לא** `yyyymm` - ה-API של הלמ"ס דורש דווקא את הפורמט הזה, וזו הייתה סיבת שגיאות 500 שנצפו בבדיקה). קורא ל-`fetchCbsSeries({startPeriod: period, endPeriod: period})`, מחפש שורה תואמת ל-`monthKey`, שומר בקאש ומחזיר `value`, או `null` אם אין התאמה.
- **`getLatestIndex(cache)`**: אם יש קאש ולא עברה שעה (`CACHE_TTL_MS`) - מחזיר אותו. אחרת `fetchCbsSeries({last: 1})`, ממיין לפי `month` **תיאורי** (`(a,b) => a.month < b.month ? 1 : -1`), לוקח את הראשון (החדש ביותר). שומר גם ב-`latestIndexCache` וגם ב-`monthIndexCache` (חוסך fetch נפרד אם אח"כ יבקשו את החודש הזה ספציפית). אם ריק - `throw new Error('CBS API returned no CPI data')`.
- **`mountCpiRoutes(app)`**: יוצר `cache = createCpiCache()` (מופע נפרד לכל mount).
  - **`GET /api/cpi/latest`**: מחזיר `{month, value}`. בכישלון - **fail-safe**: אם יש קאש ישן (אפילו פג) - מחזיר אותו עם `stale: true` (עדיף מלשבור חישוב), אחרת 502 `'לא ניתן היה למשוך את מדד המחירים לצרכן'`.
  - **`GET /api/cpi/month/:yyyymm`**: מוודא פורמט `\d{4}-\d{2}` (400 אחרת). מחזיר `{month, value}` או **404** אם אין נתון לחודש הזה. שגיאת רשת → 502.
  - **`POST /api/cpi/months`** `{ months: [...] }`: לוקח בקשה מרוכזת של רשימת חודשים, לכל אחד (**ברצף, לא Promise.all** - `for...of` עם `await`) מנסה לשלוף - חודשים בפורמט לא תקין מדולגים בשקט, כישלון פרטני מלוגג אבל לא מפיל את הבקשה כולה. מחזיר מפה `{ 'YYYY-MM': value, ... }` (רק חודשים שהצליחו).

---

### `src/server/cpiRoutes.test.js`

#### מה הטסטים בודקים
מוק ל-`axios`, ובנייה של `cbsResponse(points)` שממחזרת את המבנה האמיתי של תגובת CBS (מאומת מול שרת חי). בודק: פורמט חודש לא תקין → 400; שליפה מוצלחת לחודש תקין; **zero-padding** של חודש בודד-ספרה (7 → "07"); 404 כשאין נתון; 502 כשה-API לא זמין; **פורמט תקופה mm-yyyy** (לא yyyymm) בפועל בפרמטרים שנשלחים ל-CBS; `/api/cpi/latest` מחזיר את המדד האחרון **וקאש בזיכרון** - קריאה שנייה לא מבצעת HTTP call נוסף; `/api/cpi/months` מחזיר מפת חודש→ערך למספר חודשים.

---

### `src/server/benchmarkRoutes.js`

#### תפקיד
נתוני מדדי ייחוס היסטוריים (S&P 500 / TA-125) - משמש את ה-frontend לצייר "התיק שלי מול השוק" לצד עקומת ההון מ-snapshotRoutes.js. נתוני שוק ציבוריים, לא ייחודיים למשתמש, ולכן (כמו quotesRoutes.js) לא דורש אימות ומיושם עם קאש אגרסיבי.

#### מערכות ולוגיקה מפורטת
- **`BENCHMARKS`**: מפה **סגורה במפורש (whitelist)** של שני מדדים בלבד: `sp500: {symbol: '^GSPC', label: 'S&P 500'}`, `ta125: {symbol: '^TA125.TA', label: 'TA-125'}`. ההערה בקוד מדגישה: זו בחירה מכוונת - **לא** endpoint פתוח לכל symbol שרירותי מה-query string, כי אין אימות ב-route הזה, ו"proxy פתוח" לכל symbol היה יכול להיות וקטור abuse קל.
- **`CACHE_TTL_MS = 6h`**.
- **`getCachedBenchmarkHistory(symbol, fromDateStr)`**: אותו דפוס קאש+inFlight (מפתח `${symbol}:${fromDateStr||'default'}`), קורא ל-`fetchYahooHistoricalCloses`. **שים לב**: כאן, בשונה מ-sectorRoutes/correlationRoutes, **אין** try/catch פנימי - שגיאה עולה ישירות ל-route handler (ומטופלת שם).
- **`GET /api/benchmark-history/:key`**:
  1. `BENCHMARKS[req.params.key]` - אם לא קיים (key לא ברשימה הלבנה) → 400 `'מדד לא נתמך'`.
  2. `from` אופציונלי (מוודא פורמט).
  3. `getCachedBenchmarkHistory(...)` - בהצלחה מחזיר `{key, label, symbol, points}`.
  4. בכישלון - מלוגג עם context מלא (key, symbol, error), מחזיר 502 `'לא ניתן היה למשוך נתוני מדד ייחוס'`.
- **ייצוא**: גם `BENCHMARKS` מיוצא (לשימוש אפשרי במקום אחר בקוד/טסטים).

---

### `src/server/stockResearchRoutes.js`

#### תפקיד
תומך בעמוד "חקר מניות" (Stock Research): נתוני יסוד (fundamentals) למניה בודדת שהמשתמש מחפש (לא batch של תיק שלם), וגם autocomplete לחיפוש טיקר/חברה. נתונים ציבוריים, בלי אימות. **שונה מכל שאר ה-*Routes.js**: אלה GET עם path/query param (סימבול אחד בכל פעם), לא POST עם מערך symbols.

#### מערכות ולוגיקה מפורטת
- **`RESEARCH_CACHE_TTL_MS = 6h`** (תואם analystRoutes/dividendRoutes), **`FAILURE_CACHE_TTL_MS = 5min`**, **`SEARCH_CACHE_TTL_MS = 10min`** (תוצאות autocomplete כמעט לא משתנות).
- שני זוגות Map: `researchCache/researchInFlight` (למניה בודדת) ו-`searchCache/searchInFlight` (לחיפוש טקסט חופשי).
- **`getCachedResearch(symbol)`**: דפוס קאש+inFlight רגיל. קורא ל-`fetchYahooStockResearch(symbol)`. בכישלון - שומר `data: null, isFailure: true` ומחזיר `null`.
- **`getCachedSearch(query)`**: קורא ל-`fetchYahooSymbolSearch(query)`. בכישלון - מחזיר `[]` (**לא נשמר קאש-כישלון בכלל** - אין `isFailure` פה, שונה מ-getCachedResearch).
- **`GET /api/stock-research/:symbol`**:
  1. `symbol = trim().toUpperCase()` - אם ריק → 400 `'missing symbol'`.
  2. `data = await getCachedResearch(symbol)` - אם `null` (כשל) → **502** `'לא ניתן היה למשוך נתוני מנייה'`.
  3. אחרת מחזיר `{ symbol, research: data }`.
- **`GET /api/stock-search?q=...`**:
  1. `query = trim()` - אם קצר מ-2 תווים → מחזיר `{ results: [] }` **בלי לקרוא ל-Yahoo בכלל** (חוסך קריאות סרק לחיפוש חד-אותי).
  2. אחרת `getCachedSearch(query)` → `{ results }`.

---

### `src/server/stockResearchRoutes.test.js`

#### מה הטסטים בודקים
מוק ל-`yahooQuotes`. בודק ל-`GET /api/stock-research/:symbol`: מחזיר research data תוך UPPER-CASE (`koal1` → `KOAL1`); 502 (לא קריסה) על כישלון; קאש per-symbol (בקשה שנייה לא קוראת מחדש). ל-`GET /api/stock-search`: תוצאות לquery תקין; מערך ריק בלי קריאת Yahoo לquery קצר מ-2 תווים; מערך ריק (לא שגיאה) על כישלון חיפוש; קאש per-query.

---

### `src/server/taseApi.js`

#### תפקיד
ממשק ל-**TASE Data Hub API הרשמי** (מוצר "Securities Prices - Online (15-minute delay)") - מחליף בעתיד את ה-scraping השברירי (taseScraper.js) ב-REST API אמיתי, מתועד ויציב, **אם** מוגדר `TASE_API_KEY` **וגם** המוצר אושר (הרשמות מתחילות ב-status "PENDING" ב-developer portal, וצריכות אישור צוות מכירות הדאטה של TASE כדי שקריאות יתחילו להצליח). `quotesRoutes.js` מנסה זאת ראשון ומדלג-אוטומטית ל-scraper אם לא מוגדר/נכשל - כך שכלום לא נשבר בזמן ההמתנה לאישור, וכלום לא צריך להשתנות בקוד כשהוא יאושר.

#### מערכות ולוגיקה מפורטת
- **`TASE_API_BASE_URL = 'https://datawise.tase.co.il'`**, **`TASE_API_TIMEOUT_MS = 8000`**.
- **`isTaseApiConfigured()`**: `Boolean(process.env.TASE_API_KEY)`.
- **`fetchTaseQuoteFromApi(securityId)`**:
  1. אם לא מוגדר `TASE_API_KEY` - זורק **מיידית** `'TASE_API_KEY not configured'` (בלי אפילו לנסות axios).
  2. `doRequest()`: `GET {TASE_API_BASE_URL}/v1/securities-trading-data/last-updated` עם `params: {securityId}`, headers `{apikey: TASE_API_KEY, 'accept-language': 'he-IL', Accept: 'application/json'}`, timeout 8s.
  3. **טיפול ב-429**: אם הבקשה הראשונה נכשלת עם status 429 (rate limit) - ממתין **1 שנייה** (`setTimeout`) ומנסה **פעם אחת** נוספת. כל שגיאה שאינה 429 (כמו 401 כשהמוצר עדיין ב-PENDING) - נזרקת ישירות בלי retry. ההערה בקוד: המגבלה המתועדת של TASE (10 בקשות/2 שניות, גלובלית לפי מפתח) נדיבה, אבל התפרצות קצרה (כמה טאבים בו-זמנית) יכולה לחצות אותה רגעית.
  4. **פענוח תגובה**: `response.data.securitiesLastUpdate.result` - מערך; לוקח את `result[0]`. אם אין entry - `throw new Error('missing data in TASE API response')`.
  5. `currentPrice = Number(entry.securityLastPrice)`, `changePercent = Number(entry.securityPercentageChange)` - אם אחד מהם לא סופי - `throw new Error('non-numeric price/change in TASE API response')`.
  6. **חשוב**: הערך כבר **באגורות** (למשל 1538 = 15.38 ש"ח) - זו אותה קונבנציה שה-scraper (`taseScraper.js`'s `parsePriceToken`) כבר מצפה לה, כך **שאין** צורך בהמרה נוספת פה.
- מייצא `{ isTaseApiConfigured, fetchTaseQuoteFromApi }`.

---

### `src/server/taseApi.test.js`

#### מה הטסטים בודקים
מוק ל-`axios`. בודק: `isTaseApiConfigured()` תלוי ב-`TASE_API_KEY` (משתמש ב-`jest.resetModules()` כדי לבדוק שני מצבים); `fetchTaseQuoteFromApi` זורק מיידית בלי לקרוא axios אם אין מפתח; פענוח נכון של תשובה מוצלחת ל-`{currentPrice, changePercent}` **כבר באגורות** (בלי המרה), כולל בדיקת ה-headers/params שנשלחים; **retry אחד** אחרי 429 שמצליח בניסיון השני; שגיאה שאינה 429 (כמו 401) מתפשטת **בלי retry**; מערך `result` ריק/פגום → שגיאה מפורשת (לא bogus data); שדות לא-נומריים → שגיאה מפורשת (לא NaN שקט).

---

### `src/server/taseScraper.js`

#### תפקיד
מנגנון ה-scraping בפועל למחירי מניות ב-TASE (בורסת תל אביב): שילוב של **Puppeteer** (דפדפן headless אמיתי - מטפל בדף שנטען דינמית עם JS) עם **fallback ל-Axios+Cheerio** (HTTP סטטי בלבד, מהיר וזול יותר אך לא רץ JS - עובד רק אם התוכן הרלוונטי כלול ב-HTML הראשוני). כולל קאש קצר-TTL (60 שניות). הקובץ הזה חולץ מ-server.js המקורי בלי שינוי התנהגות.

#### מערכות ולוגיקה מפורטת

**קאש**:
- **`TASE_CACHE_TTL_MS = 60,000`** (60 שניות).
- **`taseQuoteCache` (Map)**: `stockId -> { data, ts }`.
- **`readCachedTaseQuote(stockId)`**: מחזיר את הערך רק אם `Date.now() - cached.ts <= TASE_CACHE_TTL_MS`, אחרת `null`.
- **`readStaleTaseQuote(stockId)`**: מחזיר את הערך **בלי בדיקת TTL בכלל** - "המילה האחרונה" למקרה שכל הscraping נכשל.
- **`writeCachedTaseQuote(stockId, data)`**: כותב `{ data, ts: Date.now() }`.

**Puppeteer setup**:
- **`getPuppeteerExecutablePath()`**: מעדיף `PUPPETEER_EXECUTABLE_PATH`/`CHROME_BIN` מהסביבה, אחרת `puppeteer.executablePath()` (הבינארי שהותקן אוטומטית עם החבילה), עם try/catch שמחזיר `undefined` בכישלון (משמעו: תן ל-puppeteer לבחור ברירת מחדל).
- **`getBrowser()`**: singleton - שומר `browserPromise` module-level. אם עדיין לא קיים, בונה `launchOpts` עם `headless: 'new'` (או `false` אם `PUPPETEER_HEADLESS=0`, לצורך debug ויזואלי מקומי), ודגלים חיוניים לסביבת container (`--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage` - קריטי כי `/dev/shm` קטן ב-containers כמו Render יכול לגרום ל-Chrome לקרוס, `--disable-gpu`, `--no-first-run`, `--no-default-browser-check`). אם launch נכשל - מאפס `browserPromise = null` (כדי שהקריאה הבאה תנסה מחדש) וזורק.
- **`TASE_PUPPETEER_GOTO_MS`** (ברירת מחדל 30000) ו-**`TASE_PUPPETEER_WAIT_MS`** (ברירת מחדל 12000) - ניתנים לקונפיגורציה מהסביבה.

**פונקציות פרסור טהורות (משוכפלות במכוון)**:
- **`parseTasePriceToken(token)`**: מנקה תווי bidi/control (`‎‏‪-‮⁦-⁩`), רווחים, ופסיקים (מפרידי אלפים), ואז `parseFloat` + `Math.round`. **חשוב**: **לא** מכפיל ב-100 - התוכן שנגרד הוא כבר ערך אגורות (הכיתוב באתר TASE הוא במפורש "שער אחרון (**באגורות**)"). זהו fix לבאג production אמיתי שתואר בפירוט (ראו בהמשך).
- **`isFiniteNumber(value)`**: בודק `typeof === 'number' && Number.isFinite`.
- **`hasUsableTasePriceText(text)`**: בודק אם הטקסט מכיל תבנית של תווית **ועד 80 תווים לאחריה** ספרה: `שער\s*אחרון[^\d]{0,80}\d`, או `שווי\s*יחידה[^\d]{0,80}\d`, או אחוז חוקי כלשהו (`-?\d[\d.,]*\s*%`). זו העתקה מדויקת של תנאי ה-`waitForFunction` שרץ בתוך הדפדפן (הערת קוד מסבירה: Puppeteer מסריאלז את הפונקציה להרצה בקונטקסט הדפדפן, ולכן היא לא יכולה לקרוא לקוד מודול Node הזה - הפונקציה הכפולה כאן קיימת רק כדי לאפשר unit test בלי דפדפן אמיתי; אם התנאי משתנה יש לעדכן את שתי ההעתקים).
- **`isUsableTasePayload(payload)`**: `payload && isFiniteNumber(currentPrice) && isFiniteNumber(changePercent)` - קובע אם payload "שמיש" (לא null/NaN בשדות הקריטיים).

**`scrapeTaseWithPuppeteer(taseUrl)`**:
1. `getBrowser()` → `browser.newPage()`.
2. `page.setUserAgent(...)` - User-Agent של Chrome אמיתי (למניעת חסימת bot).
3. `page.goto(taseUrl, { waitUntil: 'domcontentloaded', timeout: TASE_PUPPETEER_GOTO_MS })`.
4. **`page.waitForFunction`**: מחכה שבפועל **ערך מספרי** (לא רק תווית) יופיע ב-`document.body.innerText`, עם התנאי המדויק שתואר לעיל (`hasUsableTasePriceText`'s logic, inline). **זו התיקון לבאג production מתועד**: עמוד TASE מרנדר את התוויות (`שער אחרון` וכו') כ-shell סטטי מיידי, ומזין את המספרים בפועל רגע לאחר מכן דרך fetch אסינכרוני - התנאי הישן בדק רק נוכחות תווית/`%`, שהתקיים כמעט מיידית (עוד לפני שהמספר נטען), כך שהחילוץ רץ על עמוד שעדיין בטעינה. אם ה-wait נכשל (timeout) - `catch` שקט עם `setTimeout(1000)` (המשך בכל זאת, במקום כישלון מוחלט).
5. **`page.evaluate(...)`** - מריץ קוד **בתוך הדפדפן** (אין גישה למשתני מודול Node):
   - `normalizeText`: ממיר מינוס Unicode (`−‒–—`) ל-ASCII `-`, מסיר bidi/control chars, מכווץ whitespace.
   - `parsePercentToken(token)`: מזהה שליליות בכל דרך (מינוס בכל מקום, כולל בסוגריים), מחלץ את החלק המספרי (`\d+(?:\.\d+)?`), מחזיר שלילי אם `isNegative`.
   - `parsePriceToken(token)`: זהה ל-`parseTasePriceToken` (ראו הערה על הבאג ה-100x למעלה: `₪2,476.70` נגרד כ-`247,670`, פורסר נכון ל-`247670`, ואז **הוכפל שוב ב-100 בטעות** ל-`24,767,000` בקוד הישן - התיקון הוא **לא** להכפיל).
   - **Regex extraction**: `priceNumberRx = '(\\d[\\d\\s,.]*)'`. שלושה regex לחיפוש מחיר עם עדיפות: `lastPriceRx` (שער אחרון) → `priceRx` (שווי יחידה) → `openRx` (שער פתיחה) - הראשון שמתאים "מנצח" (`||`). לאחוז: `changeDailyRx` ("שינוי יומי") → `anyPercentRx` (כל `%` בעמוד) - `percentToken` תומך בסוגריים/מינוס Unicode.
   - **היוריסטיקת צבע**: אם `changePercent` פורסר כחיובי אבל אין מינוס מפורש בטוקן - בודק אם קיים DOM element עם אותו טקסט שנראה "שלילי" ע"פ: מחלקת CSS/title/aria-label/תוכן טקסט עם מילות מפתח (`ירידה|שלילי|minus|neg|down|ירד|אדום`), או צבע חשוב "אדמדם" (בדיקת `rgb(...)` בטווח אדום, או hex התחלה ב-`#d`/`#c`) - אם כן, כופה `changePercent = -Math.abs(changePercent)`. זו הגנה נוספת למקרה שהעמוד מציג שינוי שלילי ויזואלית (צבע אדום) בלי סימן מינוס טקסטואלי.
   - מחזיר `{ currentPrice, changePercent, _debugTextSnippet (400 תווים ראשונים), _debugPriceMatch: {matchedLabel, rawToken, fullMatch} }` - שדות debug **לא** משמשים חישוב, רק diagnostics ללוג.
6. `finally: page.close().catch(() => {})`.

**`scrapeTaseFallbackWithAxios(taseUrl)`**: fallback סטטי כשPuppeteer נכשל.
- `axios.get(taseUrl, {responseType:'text', headers: {User-Agent, Accept-Language: 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'}, timeout: 12000})`.
- `axiosBodyToHtmlString(data)`: מטפל גם ב-string וגם ב-Buffer.
- `cheerio.load(html)` → `$('body').text()` → אותם regex בדיוק (מוגדרים בנפרד, לא משותפים עם ה-page.evaluate, כי אלה שני runtime שונים) - אותה לוגיקת `normalizeText`/`parsePriceToken`/`parsePercentToken`.
- מחזיר `{currentPrice, changePercent, _rawPercentToken, _debugTextSnippet, _debugPriceMatch}`.

**ייצוא**: `readCachedTaseQuote, readStaleTaseQuote, writeCachedTaseQuote, isUsableTasePayload, hasUsableTasePriceText, parseTasePriceToken, scrapeTaseWithPuppeteer, scrapeTaseFallbackWithAxios`.

---

### `src/server/taseScraper.test.js`

#### מה הטסטים בודקים
מוק ל-`puppeteer`/`cheerio` (לא נחוצים, רק לוגיקת regex טהורה נבדקת). **Regression test לבאג production אמיתי מתועד** (הכפלה כפולה ב-100):
- `parseTasePriceToken`: "247,670" → 247670 (**לא** 24767000!) - הבדיקה המרכזית; שאר הבדיקות: הסרת פסיקי אלפים, טוקן בלי פסיק, עיגול (לא קיטום) של ערכי אגורות עשרוניים (1538.6 → 1539), החזרת `null` לקלט לא תקין, הסרת bidi/control chars.
- `hasUsableTasePriceText`: **הרגרסיה המדויקת** - הטקסט שנצפה בפועל ב-production **לפני** התיקון (תוויות קיימות אבל "undefined undefined" במקום ערך) - כעת נכון להיחשב `false`; תווית + ערך מספרי מיידי → `true`; "שווי יחידה" עם מספר → `true`; אחוז תקין בלי תווית מחיר בקרבה → `true`; `%` בלי ספרות (טקסט דקורטיבי) → `false`; קלט ריק/undefined/null → `false` בלי לזרוק שגיאה; תווית מרוחקת מדי (>80 תווים) מספרה → `false`.

---

### `src/server/yahooCrumb.js`

#### תפקיד
משיג ומטמון (cache) את הזוג "session cookie + crumb token" הדרוש לגישה ל-endpoint `quoteSummary` (v10) של Yahoo Finance. ה-endpoint הפשוט יותר (`chart`, v8) עובד בלי אימות מיוחד, אבל `quoteSummary` (המשמש לנתוני סקטור/אנליסטים/דיבידנד/מחקר מניה) מחזיר 401 "Invalid Crumb" בלי cookie+crumb תואמים. זהו workaround לא-רשמי ל-API לא-רשמי - Yahoo יכול לשנות את המכניזם הזה בכל רגע בלי הודעה מוקדמת (וזה כבר קרה בעבר).

#### מערכות ולוגיקה מפורטת
- **`BROWSER_HEADERS`**: User-Agent של Chrome + Accept headers סטנדרטיים - מחקה דפדפן אמיתי.
- **`CRUMB_TTL_MS = 55min`**: מתרענן קצת לפני תפוגת session טיפוסית של שעה.
- **`cached` (module-level)**: `{ crumb, cookie, ts } | null`.
- **`inFlightRequest`**: מונע ריבוי ריצות מקבילות של תהליך ההשגה.
- **`extractCookieHeader(setCookieHeaders)`**: מקבל header `set-cookie` (יכול להיות string או array), לכל אחד קורע את החלק שלפני `;` (הערך עצמו, בלי attributes כמו Path/Expires), ומצרף בפורמט `"a=1; b=2"` - פורמט תואם ל-header `Cookie` שנשלח בבקשות הבאות.
- **`fetchSessionCookie()`**:
  1. **שלב 1**: מנסה `https://fc.yahoo.com` (העמוד "הקל ביותר" שמזין cookies בסיסיים בלי לטעון עמוד finance מלא) - עם `maxRedirects: 0` ו-`validateStatus: () => true` (מקבל כל status code, לא רק 2xx, כי redirect (3xx) הוא מה שבפועל נדרש כדי לקרוא את ה-set-cookie header). אם יש cookie - מחזיר.
  2. **Fallback**: אם השלב הראשון נכשל (exception) - `https://finance.yahoo.com` (עמוד כבד יותר, אבל גם מזין cookies).
- **`fetchCrumb(cookie)`**: `GET https://query1.finance.yahoo.com/v1/test/getcrumb` עם header `Cookie`. התגובה היא string גולמי (לא JSON). ולידציה: אם ה-crumb ריק, ארוך מ-100 תווים, או מכיל `<` (סימן שחזר עמוד HTML של שגיאה עם status 200 מטעה) - `throw new Error('did not receive a valid yahoo crumb')`.
- **`getYahooCrumbAndCookie(forceRefresh = false)`**:
  1. אם לא `forceRefresh` ויש קאש תקף (תוך 55 דקות) - מחזיר אותו.
  2. אם יש `inFlightRequest` פעיל - מצטרף אליו (מונע ריבוי בקשות במקביל).
  3. אחרת מריץ: `fetchSessionCookie()` (זורק אם לא הצליח לקבל cookie) → `fetchCrumb(cookie)` → שומר `{crumb, cookie, ts: Date.now()}` בקאש ומחזיר.
  4. `finally: inFlightRequest = null` (בהצלחה או כישלון).
- **`invalidateYahooCrumb()`**: מאפס את הקאש ל-`null` - נקרא כשבקשה עם crumb מטומן חוזרת עם unauthorized, כדי שהניסיון הבא יביא זוג טרי במקום לנסות שוב עם מה שכבר ידוע כישן.

---

### `src/server/yahooQuotes.js`

#### תפקיד
מודול מרכזי ומרכיב את **כל** הפעולות שמדברות בפועל עם Yahoo Finance (הן ה-endpoint הפשוט `chart` v8 והן `quoteSummary` v10 המורכב יותר, כמו גם `search`, `recommendationsbysymbol`, `fundamentals-timeseries` ועוד). כל שאר קבצי הראוטים (quotesRoutes, sectorRoutes, analystRoutes, dividendRoutes, newsRoutes, correlationRoutes, benchmarkRoutes, stockResearchRoutes) מייבאים ממנו פונקציות ספציפיות. מגדיר גם את תור ה-throttling המשותף לכל קריאות quoteSummary-authenticated.

#### מערכות ולוגיקה מפורטת

**קאש בסיסי למחיר "עכשיו" (`getYahooPayload`)**:
- **`YAHOO_CACHE_TTL_MS = 15,000`** (15 שניות - קצר בהרבה מ-TASE cache, כי Yahoo קל יותר לקרוא לו בתדירות).
- **`fetchYahooChartMeta(symbol)`**: `GET /v8/finance/chart/{symbol}` - מחלץ `result[0].meta`. אם חסר - `throw new Error('missing yahoo chart data')`.
- **`getYahooPayload(symbol)`**:
  1. בודק קאש (`readCachedYahoo`), אחר-כך in-flight, אחר-כך fetch חדש.
  2. `currentPrice = Number(meta.regularMarketPrice)`.
  3. **`previousClose = Number(meta.previousClose ?? meta.chartPreviousClose)`** - fallback לשדה השני אם הראשון חסר.
  4. **חשוב - חישוב שינוי אחוזי מהמקור, לא משדה Yahoo מוכן**: `finalChangePercent = ((currentPrice - previousClose) / previousClose) * 100`, מחושב **רק** אם שני הערכים סופיים ו-`previousClose !== 0`, אחרת `0`. הערת קוד מפורטת מסבירה **מדוע בכוונה לא** נעשה שימוש בשדות `regularMarketChangePercent`/`changePercent`/`regularMarketChange`/`change`: הם לרוב חסרים לגמרי בתגובות v8 real-world, ואפילו כשקיימים - `regularMarketChange`/`change` הם **סכומים מוחלטים** (למשל $2.34, לא אחוז), ושדות `*ChangePercent` לא עקביים בסקאלה (שבר לעומת אחוז). קוד ישן הכפיל כל שדה שנמצא ב-100 ללא הבחנה - זו הסיבה לדוח production אמיתי על "אחוזי שינוי שגויים".
  5. `payload = { currentPrice: isFinite ? currentPrice : null, changePercent: isFinite ? finalChangePercent : 0 }` - נשמר בקאש.

**היסטוריה יומית (`fetchYahooDailyCloses` - פונקציית עזר משותפת)**:
- `GET /v8/finance/chart/{symbol}?period1&period2&interval=1d`.
- מחלץ `timestamp[]` ו-`indicators.quote[0].close[]`, מדלג על ערכי close null/לא-סופיים. מחשב תאריך `YYYY-MM-DD` מ-**UTC seconds** (הערה: מספיק מדויק לשורות יומיות - סשן מסחר לא חוצה חצות UTC בכל אזור זמן רלוונטי).
- **`fetchYahooHistoricalCloses(symbol, fromDateStr)`**: `period1` = תאריך מבוקש (או `~400 יום` אחורה כברירת מחדל - כ-13 חודשים), `period2` = עכשיו. משמש להשוואת benchmark וקורלציה.
- **`fetchYahooHistoricalRateForDate(symbol, dateStr)`**: חלון **צר** בלבד (שבוע לפני עד יום אחד אחרי התאריך המבוקש, לא כל הטווח עד היום - כי מדובר בתאריך יחיד היסטורי, לא בהיסטוריה מצטברת). מסנן `points` ל-`p.date <= dateStr`, לוקח את **האחרון מביניהם** (points ממוינים עולה) - "יום המסחר האחרון בתאריך המבוקש או לפניו" (כי ל-FX אין בר בשבתות/חגים). מחזיר `null` (**לעולם לא ממציא ערך**) אם אין אף נקודה תואמת בחלון.

**חדשות וחיפוש (ללא crumb, ציבוריים)**:
- **`fetchYahooNews(symbol, count=10)`**: `GET /v1/finance/search?q={symbol}&newsCount={count}&quotesCount=0`. מסנן ל-`uuid && title && link` בלבד (חלק מהפריטים חסרים link בפועל - מתועד עם דוגמה אמיתית בטסטים). מחלץ `publishedAtEpoch` דרך `unwrapYahooNumber`.
- **`fetchYahooSymbolSearch(query, count=8)`**: `GET /v1/finance/search?q={query}&newsCount=0&quotesCount={count}`. מסנן ל-`quoteType === 'EQUITY'` בלבד, מעדיף `longname` על `shortname`.

**מנגנון Throttling ל-quoteSummary (`scheduleOnQuoteSummaryQueue`)**:
- **`QUOTE_SUMMARY_MIN_SPACING_MS = 350`**, **`QUOTE_SUMMARY_429_BACKOFF_MS = 1500`**.
- **`quoteSummaryQueueTail`**: Promise module-level ("זנב" תור) שמשותף בין **כל** הקריאות (לא per-caller) - sectorRoutes ו-analystRoutes שניהם עושים `Promise.all` על כל טיקר בתיק, כך שתיק עם ~10 החזקות יכול לשלוח ~20 בקשות quoteSummary כמעט-בו-זמנית. Yahoo מגיב ל-burst כזה עם 429.
- **`scheduleOnQuoteSummaryQueue(task)`**: מצרף `task` לזנב התור. חשוב: משתמש ב-**`.finally()` (לא `.then()`)** אחרי ה-task כדי שהפוגה (spacing delay) תחול **בין הצלחה לכישלון** - burst של כישלונות (כמו 429 חוזרים) צריך את אותו pacing כמו burst של הצלחות. הזנב עצמו **תמיד resolve** (גם אם ה-task נכשל) כדי שלא "יתקע" בקשות ממתינות מאחוריו.
- **`fetchYahooWithCrumbRetry(url, extraParams)`**:
  1. `doRequest(forceRefreshCrumb)`: מביא crumb/cookie, שולח `GET url` עם `params: {...extraParams, crumb, formatted:false}` (**`formatted:false`** מבקש מ-Yahoo מספרים "רגילים" ולא shape תצוגתי `{raw,fmt}` - אבל, כמצוין בהמשך, לא כל שדה מכבד את זה בפועל).
  2. **retry על crumb ישן**: אם התגובה נכשלת עם 401/403 - `invalidateYahooCrumb()` ומנסה שוב עם `forceRefreshCrumb=true`.
  3. הכל עובר בתוך `scheduleOnQuoteSummaryQueue`.
  4. **retry על 429**: מחוץ למקום התור המקורי - ממתין `QUOTE_SUMMARY_429_BACKOFF_MS` (1.5s) ומנסה שוב, פעם אחת, על תור נפרד.
- **`fetchYahooQuoteSummary(symbol, modules)`**: `GET /v10/finance/quoteSummary/{symbol}?modules=...` דרך `fetchYahooWithCrumbRetry`. מחזיר `result[0]` או זורק אם חסר.

**Fundamentals timeseries (`fetchYahooFundamentalsTimeseries`)**:
- **`FUNDAMENTALS_TIMESERIES_TYPES`**: רשימה ארוכה (~25 types) של סוגי דוחות שנתיים (EPS, EBIT, invested capital, net income, total assets, revenue, cost of revenue, operating expense, tax provision, pretax income, interest expense, free cash flow, operating cash flow, capex, cash, current assets/liabilities, total liabilities, current/long-term debt, stockholders equity, working capital, net PPE, goodwill, retained earnings) - הערה בקוד: זו החלופה ל-`balanceSheetHistory`/`incomeStatementHistory` של quoteSummary, שמאומת (בפיתוח) כמחזיר "קונכיות" ריקות (תאריכים בלי מספרים בפועל) לטיקרים אמיתיים - endpoint זה מאומת שמחזיר נתונים מלאים.
- `GET /ws/fundamentals-timeseries/v1/finance/timeseries/{symbol}?type=<joined>&period1&period2` (חלון ~6 שנים אחורה - מרווח מעבר לטרנד 5 השנים שהצ'קים דורשים), דרך `fetchYahooWithCrumbRetry` (אותה queue).
- מפרסר: לכל `entry` ב-`results`, `type = entry.meta.type[0]`, לוקח את המערך `entry[type]`, מסנן `Boolean` (מסיר placeholders `null` ש-Yahoo משתיל לתקופות בלי דיווח), ממפה ל-`{date: asOfDate, value: unwrapYahooNumber(reportedValue)}`, מסנן שוב `date && value !== null`, ומיין לפי תאריך עולה.

**`unwrapYahooNumber(value)`**: "הגנה" מרכזית מאוד - Yahoo מחזיר שדות נומריים כמספר פשוט **או** כאובייקט `{raw, fmt, longFmt}` (כשה-`formatted=false` לא נכבד לשדה מסוים, שקורה בפועל בצורה לא-עקבית). מחזירה `null` ל-null/undefined, את הערך עצמו אם מספר סופי, את `value.raw` אם הוא אובייקט עם `raw` סופי, אחרת `null`.

**נתוני סקטור (`fetchYahooAssetProfile`)**: `quoteSummary` עם module `assetProfile` - מחלץ `sector`/`industry`. אם `profile` חסר - זורק.

**נתוני אנליסטים (`fetchYahooAnalystData`)**: `quoteSummary` עם `'financialData,recommendationTrend,upgradeDowngradeHistory'`.
- `upgradeHistory`: ממפה `entry.epochGradeDate` דרך `unwrapYahooNumber`, מסנן ערכי `null`, **ממיין לפי תאריך יורד** (חדש-לישן), חותך ל-8.
- `currentTrend`: מוצא `trend.period === '0m'` (החודש הנוכחי) או ברירת מחדל `trend[0]` - מחלץ `strongBuy/buy/hold/sell/strongSell`.
- מחזיר `{recommendationKey, numberOfAnalystOpinions, targetMeanPrice, targetHighPrice, targetLowPrice, currentTrend, upgradeHistory}`.

**נתוני דיבידנד+earnings (`fetchYahooDividendSummary`)**: `quoteSummary` עם `'summaryDetail,calendarEvents'`.
- `dividendYieldPercent = yieldFraction * 100` (Yahoo מחזיר `dividendYield` **כשבר** - 0.0236, לא 2.36 - מומר כאן לאחוז; **בכוונה לא** נעשה שימוש ב-`fiveYearAvgDividendYield` שהוא **כבר** אחוז - שדה נפרד עם סקאלה שונה מ-Yahoo, בחירה שיש עליה הערה מפורשת בקוד וגם בטסט).
- `earningsDateRaw = calendarEvents.earnings.earningsDate[0]` (המערך יכול להכיל 1-2 תאריכים לטווח משוער - נלקח הראשון כאומדן ראשי).
- מחזיר `{dividendRate, dividendYieldPercent, payoutRatio, exDividendDateEpoch, nextDividendDateEpoch, earningsDateEpoch, isEarningsDateEstimate, epsEstimateAverage, revenueEstimateAverage}`. `exDividendDateEpoch` נופל לשני מקורות (`summaryDetail.exDividendDate ?? calendarEvents.exDividendDate`).

**היסטוריית דיבידנד בפועל (`fetchYahooDividendHistory`)**: `GET /v8/finance/chart/{symbol}?events=div&period1&period2` - **ציבורי, בלי crumb**. `period1` ברירת מחדל **5 שנים** אחורה (שונה מ-`fetchYahooHistoricalCloses`'s ~400 יום - כי דיבידנדים משולמים רבעונית, טווח קצר יפסיד רוב היסטוריית תשלום להחזקה ארוכת-שנים). מחלץ `chart.result[0].events.dividends` (אובייקט, לא מערך - `Object.values`), ממפה ל-`{date, amountPerShare}`, מסנן לא-סופי, ממיין עולה.

**"חברות דומות" (`fetchYahooSimilarCompanies`)**: `GET /v6/finance/recommendationsbysymbol/{symbol}` - **ציבורי, בלי crumb** (מאומת בפיתוח). מחזיר `{symbol, score}[]`.

**P/E לעמיתים (`fetchYahooPeerQuotes`)**: `GET /v7/finance/quote?symbols=<joined>` דרך `fetchYahooWithCrumbRetry` (אותה queue/auth כמו quoteSummary). מחזיר `{symbol, trailingPE}[]`. נקרא **רק** עם התוצאה של `fetchYahooSimilarCompanies` - אין קונספט "עמיתים" בלעדיו.

**מחקר מניה מלא (`fetchYahooStockResearch`)** - הפונקציה העשירה ביותר במודול, לשאילתת מניה בודדת (לא batch תיק, ולכן "יכולה להרשות לעצמה" קריאות מרובות משולבות):
1. `Promise.all` מקביל של: `fetchYahooQuoteSummary` עם 7 modules (`summaryDetail,defaultKeyStatistics,financialData,earningsTrend,insiderHolders,institutionOwnership,assetProfile,insiderTransactions`), `fetchYahooFundamentalsTimeseries` (עם `.catch → {}`), `fetchYahooSimilarCompanies` (עם `.catch → []`), `fetchYahooHistoricalCloses(symbol, 3 שנים אחורה)` (עם `.catch → []`) - **כל אחד עם degrade-בנפרד**, לא כישלון-כולל.
2. `peerQuotes = fetchYahooPeerQuotes(peerSymbols)` - **לא** יכול להיות ב-Promise.all הראשי כי תלוי בתוצאת `similarCompanies` - נקרא לאחר מכן, עם `.catch → []` גם הוא.
3. **חילוץ נתונים** - מקובצים לקטגוריות ה-scorecard (ב-`stockScorecard.js`, לא נכלל ברשימה שנסקרה כאן):
   - **Value**: `trailingPE, forwardPE, pegRatio, priceToBook`.
   - **Future growth**: `earningsGrowth, revenueGrowth, nextYearEarningsGrowth` (מ-`earningsTrend.trend` עם `period==='+1y'`), `targetMeanPrice, currentPrice`.
   - **`marketCap`**: מ-`summaryDetail.marketCap` (**לא** מ-`defaultKeyStatistics.sharesOutstanding × price` - הערת קוד: `marketCap` תמיד קונסיסטנטי עם `currentPrice` כי הוא נגזר מאותה ציטוט חי, בשונה מ-`sharesOutstanding` המדווח בנפרד שיכול "לפגר" אחרי split).
   - **Financial health**: `currentRatio, debtToEquity, returnOnEquity, returnOnAssets, operatingCashflow, totalDebt`.
   - **DCF inputs**: `beta, sharesOutstanding` (עבור `dcfValuation.js`).
   - **Ownership**: `heldPercentInsiders, heldPercentInstitutions`; `insiderRecentSales`/`insiderRecentPurchases` = ספירת holders עם `transactionDescription` המכיל `/sale/i` או `/purchase/i` (regex); `topInstitutionalHolders` (5 ראשונים).
   - **`insiderTransactions`**: לוג עשיר יותר (עד 10 פריטים), ממוין לפי `startDateEpoch` **יורד** (חדש ראשון).
   - **`companyOfficers`**: שמות עם ניקוי רווחים כפולים (`o.name.replace(/\s+/g, ' ').trim()` - Yahoo מדווח בפועל שמות כמו "Mr. Kevan  Parekh" עם רווח כפול, מאומת מול תגובה אמיתית).
   - **`fundamentalsHistory`**, **`priceHistory`** (`{date, close}[]` ל-3 שנים), **`peerQuotes`**, **`companyProfile`** (סקטור/תעשייה/אתר/תיאור/עובדים/עיר/מדינה/`companyOfficers`), **`similarCompanies`**.
   - **הערה חשובה בקוד**: `balanceSheetHistory`/`incomeStatementHistory` (modules של quoteSummary) **הושמטו בכוונה** - מאומת בפיתוח שהם מחזירים "קונכיות" ריקות (תאריכים בלי ערכים בפועל) לטיקרים אמיתיים; `financialData`'s יחסים מוכנים ו-`fundamentalsHistory` (endpoint אחר) מכסים את הפער.

**ייצוא**: `getYahooPayload, fetchYahooHistoricalCloses, fetchYahooHistoricalRateForDate, fetchYahooNews, fetchYahooSymbolSearch, fetchYahooAssetProfile, fetchYahooAnalystData, fetchYahooDividendSummary, fetchYahooDividendHistory, fetchYahooStockResearch, fetchYahooFundamentalsTimeseries, fetchYahooSimilarCompanies, fetchYahooPeerQuotes, unwrapYahooNumber`.

---

### `src/server/yahooQuotes.test.js`

#### מה הטסטים בודקים
קובץ הטסטים המקיף ביותר בפרויקט, עם תגובות Yahoo אמיתיות שנתפסו במהלך הפיתוח (לא מומצאות). מכיל regression tests לשני באגים production מתועדים:
1. **`unwrapYahooNumber`**: מספר פשוט עובר כמו שהוא; unwrapping של shape `{raw, fmt}`; null/undefined/NaN/string/אובייקט-בלי-raw-סופי → `null`.
2. **429 handling (via `fetchYahooAssetProfile`)** - **רגרסיה תיעודית לבאג production אמיתי**: לפני זה, burst מקביל של `Promise.all` על כל טיקר בתיק גרם ל-429 מ-Yahoo לכל הסימולים כמעט בבת אחת. בודק: retry אחד מוצלח אחרי 429; 429 מתמשך (2 כישלונות) נכשל בסוף (לא infinite retry); שגיאה שאינה 429/401/403 מתפשטת מיידית בלי backoff (< 1000ms); **שתי בקשות מקבילות עוברות בתור עם ריווח בפועל** (≥300ms), גם כששתיהן נכשלות - זה regression test ל-**באג שני** בתוך התור עצמו: המרווח היה מיושם רק אחרי הצלחה, כך שburst של כישלונות (בדיוק המקרה של 429) עבר בלי pacing כלל.
3. **`fetchYahooNews`**: מפרסר פריט חדשות אמיתי; מסנן פריט שחסר `link`; מעבירה פרמטרים נכון; מערך ריק כשחסר `news`.
4. **`fetchYahooSymbolSearch`**: מפרסר EQUITY בלבד, מעדיף longname; מעבירה פרמטרים; מערך ריק כשחסר `quotes`.
5. **`fetchYahooDividendSummary`**: עם תגובת KO אמיתית - ממיר `dividendYield` משבר לאחוז (0.0236→2.36); מחלץ שדות earnings מהמערך הראשון; nulls כשהכל חסר.
6. **`fetchYahooFundamentalsTimeseries`**: מפרסר לפי type, מסנן `null` placeholders, ממיין; מעביר types מחוברים בפסיק + period1<period2; אובייקט ריק כשחסר result.
7. **`fetchYahooSimilarCompanies`**: מפרסר `recommendedSymbols`; קורא ל-URL בלי params/crumb (אימות שאין auth); מערך ריק כשחסר.
8. **`fetchYahooStockResearch`**: הטסט המקיף ביותר - עם mock-by-URL (לא by-call-order, כי ה-Promise.all branches לא בהכרח מסתדרים בסדר), בודק חילוץ כל קטגוריה (value/growth/health/ownership), ספירת insider sales/purchases (מתעלם מ-"Stock Award(Grant)"), top-5 institutional holders, fundamentalsHistory, ניקוי רווחים כפולים בשמות, similarCompanies, beta/sharesOutstanding/marketCap ל-DCF, מיון insiderTransactions יורד, priceHistory, peerQuotes, בקשת ה-types המורחבים ("phase 2"), **דילוג על קריאת peer-quotes HTTP כליל** אם אין חברות דומות, degrade-בנפרד לכל אחד מ-3 הפטצ'ים המשניים (fundamentals/similar/priceHistory) בלי להפיל את שאר המחקר, degrade נפרד ל-peerQuotes בלבד (כשsimilarCompanies הצליח אך peer-quotes נכשל), nulls/[] גורפים כשהכל חסר.
9. **`getYahooPayload` change-percent** - **רגרסיה תיעודית לבאג production שני**: מוכיח שהחישוב נעשה **תמיד** מ-`(currentPrice - previousClose)/previousClose*100` ולעולם לא מהשדות המטעים של Yahoo (`regularMarketChange` שהוא $ מוחלט, `regularMarketChangePercent` שהסקאלה שלו לא ברורה) - בודק במפורש שלא מתקבל `-342%` (הפלט השגוי המדויק שהיה ב-production כשחושב מ-`-3.42` דולר מוכפל ב-100).
10. **`fetchYahooHistoricalRateForDate`**: תאריך שבת → יום שישי הקודם; יום מסחר בפועל → אותו יום; יום מסחר **אחרי** התאריך המבוקש מדולג אפילו שבחלון; `null` כשאין נתון בחלון כלל; מסנן `close: null`; `null` לתאריך לא תקין **בלי לקרוא axios כלל**; מוודא חלון צר (שבוע לפני עד יום אחרי), לא הטווח הרחב של `fetchYahooHistoricalCloses`.

---

### `src/api/stockPrices.js`

#### תפקיד
שכבת עזר בצד ה-**client** (frontend, לא server!) שמעטפת קריאות `fetch` ל-endpoints השונים ב-quotesRoutes.js. הוצא (extracted) מ-App.js המקורי, בלי שינוי התנהגות. משמש גם ב-hook לרפרוש מחירים תקופתי וגם בטופס הוספה/עריכה של מניה (למילוי מחיר נוכחי בעת יצירה).

#### מערכות ולוגיקה מפורטת
- **`fetchIsraeliStockPrice(stockId)`**: `fetch(apiUrl('/api/israeli-stock/{id}'), {credentials:'include'})`. `credentials:'include'` שולח cookies (כולל `auth_token`, גם אם ה-endpoint הזה בפועל לא דורש אימות). אם `!response.ok` - `throw`; ה-`catch` תופס וזורק `null`. מחזיר את ה-JSON כמו שהוא (`{currentPrice, changePercent}`).
- **`fetchCurrentPrice(stockSymbol)`**: קורא ל-`/api/american-stock/{encodeURIComponent(symbol)}`. **בודק** שהתגובה כוללת `currentPrice` לא-null/undefined לפני שמחזיר אותה; אחרת (או בכל שגיאה) מחזיר `null`.
- **`fetchExchangeRate()`**: `/api/exchange-rate` - מחזיר `data.rate` אם קיים ותקין, אחרת `null`.
- **`fetchHistoricalExchangeRate(dateStr)`**: `/api/exchange-rate/{encodeURIComponent(dateStr)}` - מחזיר `data.rate` אם קיים, אחרת `null`. (שים לב: לא מחזיר את `data.date` בפועל - רק את ה-rate).
- **דפוס אחיד**: כל הפונקציות "בולעות" שגיאות (`try/catch` שמחזיר `null`) - הקוד הקורא להן **לעולם לא** מקבל exception, רק `null` שמייצג "לא הצלחנו לקבל נתון" - עקבי עם עקרון ה-graceful degradation שרואים בכל שכבת השרת.

---

### `src/apiBase.js`

#### תפקיד
קובע את כתובת הבסיס (base URL) של ה-API, בהתאם לסביבת ריצה - בפיתוח מקומי (ללא משתנה סביבה) נתיבים יחסיים (`/api/...`) שמנותבים על ידי proxy סטנדרטי של Create React App ל-`localhost:5000`; בפריסת production (למשל Vercel כ-frontend נפרד מ-backend על Render) - כתובת מוחלטת דרך `REACT_APP_API_URL`.

#### מערכות ולוגיקה מפורטת
- **`getApiBase()`**: `process.env.REACT_APP_API_URL || ''`, מסיר `/` בסוף אם קיים (`.replace(/\/$/, '')`) - כדי למנוע `//` כפול בהמשך.
- **`apiUrl(path)`**: מבטיח ש-`path` מתחיל ב-`/` (`path.startsWith('/') ? path : '/'+path`), ומצרף ל-base: `${getApiBase()}${p}`. אם base ריק - מתקבל נתיב יחסי בלבד (`/api/...`), שדפדפן מפרש כמתייחס ל-origin הנוכחי (ה-proxy דואג להעביר בפיתוח).

---

### `src/authToken.js`

#### תפקיד
עטיפה מינימלית ובטוחה (safe wrapper) לניהול טוקן JWT ב-`localStorage` בצד הלקוח - זהו המקום שמאפשר לשלוח את הטוקן כ-Bearer header (חלופה ל-cookie) בבקשות API. כל הפעולות עטופות ב-try/catch כדי לא לקרוס בסביבות שבהן `localStorage` חסום/לא זמין (מצב פרטיות, מגבלות דפדפן).

#### מערכות ולוגיקה מפורטת
- **`AUTH_TOKEN_KEY = 'afikinvest_auth_token'`**.
- **`getAuthToken()`**: `localStorage.getItem(...)` - אם נכשל (throw) או ריק, מחזיר `''`.
- **`setAuthToken(token)`**: אם `token` truthy, `localStorage.setItem(...)`; שגיאה מתעלמת בשקט.
- **`clearAuthToken()`**: `localStorage.removeItem(...)`; שגיאה מתעלמת בשקט.
- **הקשר למערכת האימות**: authRoutes.js מחזיר טוקן גם בגוף התשובה (`{user, token}`) בנוסף ל-cookie - זה מאפשר לצד הלקוח לשמור אותו כאן ולשלוח כ-`Authorization: Bearer <token>` (ראו `extractBearerToken` ב-authRoutes.js, שמעדיף Bearer על פני cookie) - שימושי בעיקר לתמיכה בתרחישי cross-site שבהם cookies עלולים להיחסם.

---

### `scripts/list-users.js`

#### תפקיד
סקריפט CLI חד-פעמי (הפעלה: `npm run db:users`) להדפסת כל המשתמשים הרשומים במסד הנתונים (בלי חשיפת סיסמאות) - שימושי לבדיקה/ניהול ידני מהיר בלי צורך בכלי GUI ל-DB.

#### מערכות ולוגיקה מפורטת
1. `require('dotenv').config()` - טוען משתני סביבה (כדי ש-`initDataStore` ידע אם להתחבר ל-Postgres או SQLite מקומי, בדיוק כמו server.js).
2. `store = await initDataStore()` - שימוש חוזר באותה שכבת abstraction מ-dataStore.js.
3. `rows = await store.listUsersWithPortfolio()` - שולף `{id, email, created_at, portfolio_saved_at}` לכל משתמש.
4. אם אין משתמשים - `console.log('אין משתמשים רשומים במסד.')` ו-`process.exit(0)`.
5. אחרת, לכל שורה מדפיס `#id  email  |  נוצר: created_at | תיק אחרון בשרת: portfolio_saved_at` (או `| אין עדיין תיק שמור בשרת` אם `portfolio_saved_at` הוא null).
6. מדפיס סיכום: `סה"כ: N (store.kind)` - `store.kind` הוא `'sqlite'` או `'postgres'`, כך שרואים בבירור לאיזה DB התחברו.
7. אם `store.pool` קיים (Postgres) - `await store.pool.end()` לסגירת חיבורי ה-pool בצורה מסודרת לפני יציאה (SQLite לא צריך את זה, כי הוא לא מנהל pool).
8. שגיאה כלשהי - `console.error(e)` ו-`process.exit(1)`.

---

## חלק 3: מנועי חישוב תיק ליבתיים (utils)

# תיעוד טכני מפורט - מנועי החישוב הפיננסי של afikinvest (src/utils)

> מסמך זה מתעד את קבצי החישוב המרכזיים בתיקיית `src/utils/` של אפליקציית ניהול תיק ההשקעות "afikinvest". עבור כל קובץ: תפקידו במערכת, ולאחר מכן פירוק מדויק, נוסחה-נוסחה, של כל פונקציה מיוצאת - כולל מקרי קצה, הנחות, וקומפוזיציה בין הפונקציות. קבצי הבדיקות (`*.test.js`) מתועדים בקצרה, עם ציון מקרי הבוחן המספריים המרכזיים שממחישים את ההתנהגות המיועדת.

---

### `src/utils/portfolioMath.js`

#### תפקיד

זהו קובץ הבסיס למתמטיקה של מניות אמריקאיות (כולל מיסוי רווח הון ריאלי לפי הצמדה לשער החליפין) ולניהול "תקופות" בקופות גמל (עדכון שווי, ניטרול הפקדות מהתשואה, גילוי תקופות פגומות). שאר הקבצים בפרויקט (portfolioAnalysis.js, portfolioSummary.js, sectorAnalysis.js) נשענים עליו לחישוב מדדי מניות אמריקאיות. הוא גם מייבא מ-`cpiTax.js` את מנגנון ההצמדה הכללי (`indexedCostBasis`, `calculateLinkedRealResult`) ומיישם אותו במיוחד עבור שער החליפין דולר/שקל, במקום עבור מדד המחירים לצרכן.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`TAX_RATE = 0.25`** - קבוע: שיעור מס רווח הון (25%), ברירת המחדל בכל המקום באפליקציה.

**`calculateAmericanStockMetrics(stock, taxRate = TAX_RATE)`**

זו הפונקציה המרכזית ביותר בקובץ - מחשבת את כל המדדים הכספיים של פוזיציית מניה אמריקאית בודדת (lot), הן בדולר והן בשקל, כולל המס.

קלט (`stock`): `{ purchasePrice, quantity, exchangeRate (שער בזמן הקנייה), currentPrice, currentExchangeRate (שער היום), exchangeRate כברירת מחדל אם currentExchangeRate חסר }`. כל השדות מוגנים בעזרת `|| 0` - אובייקט ריק `{}` לא יגרום לשגיאה.

שלבי החישוב:
1. `totalPurchaseUSD = purchasePrice * quantity`
2. `totalPurchaseILS = totalPurchaseUSD * exchangeRate` (שער ביום הקנייה)
3. `totalCurrentValueUSD = currentPrice * quantity`
4. `currentExchangeRate = stock.currentExchangeRate || stock.exchangeRate || 0` (נפילה חזרה לשער הקנייה אם אין שער עדכני)
5. `totalCurrentValueILS = totalCurrentValueUSD * currentExchangeRate`
6. `profitUSD = totalCurrentValueUSD - totalPurchaseUSD`
7. **`profitILS = totalCurrentValueILS - totalPurchaseILS`** - זהו הרווח **הנומינלי האמיתי** בשקלים: כמה שקלים יותר/פחות יש בפועל היום מול מה ששולם, כשכל צד מומר לפי השער שהיה בתוקף באותו רגע. שים לב: זה **לא** `profitUSD * currentExchangeRate` (שהיא בעצם הנוסחה של הרווח הריאלי, ראו למטה) - ההבחנה הזו קריטית ומתועדת בהערות הקוד כתיקון לבאג היסטורי שבו רווח דולרי אמיתי יכול היה "להיראות" כהפסד נומינלי בשקלים (או להיפך) כשהשקל השתנה משמעותית.

**הצמדה לשער החליפין ("מדד" מלאכותי) - יישום פסק דין מוזס:**
8. `adjustedCostBasisILS = indexedCostBasis(totalPurchaseILS, exchangeRate, currentExchangeRate)` = `totalPurchaseILS * (currentExchangeRate / exchangeRate)` = בעצם שווה ל-`totalPurchaseUSD * currentExchangeRate` (עלות הדולר, מומרת לשקלים לפי השער של היום).
9. `{ realGain: realGainILS, tax: taxILS } = calculateLinkedRealResult({ originalCost: totalPurchaseILS, currentValue: totalCurrentValueILS, adjustedCostBasis: adjustedCostBasisILS, taxRate })` - מיישם את הכלל האסימטרי מפסק דין מוזס (ע"א 3555/15) - ראו פירוט מלא בסעיף `cpiTax.js` למטה. בקצרה: זה בדיוק שווה ערך למיסוי הרווח בדולר בלבד (`profitUSD`) ואז המרתו לשקלים לפי שער היום - `realGainILS = profitUSD * currentExchangeRate` כאשר אין מקרי קצה חריגים.
10. `currencyExemptGainILS = profitILS - realGainILS` - החלק בפרש הנומינלי שנובע רק משינוי השער (פטור ממס), יכול להיות שלילי אם מדובר בהפסד לא-ניתן-לקיזוז.
11. `taxUSD = currentExchangeRate > 0 ? taxILS / currentExchangeRate : 0` - המרת המס חזרה לדולר (הגנה מפני חלוקה באפס).
12. `afterTaxUSD = profitUSD - taxUSD`
13. `afterTaxILS = profitILS - taxILS`
14. `exchangeRateImpact = totalCurrentValueUSD * (currentExchangeRate - exchangeRate)` - "אפקט השער" הנמדד על שווי הפוזיציה הנוכחית בדולר (לא על עלות הרכישה): כמה שקלים יותר/פחות היה השווי הנוכחי שווה אילו נמדד בשער הקנייה במקום בשער הנוכחי.

פלט: אובייקט עם כל 15 השדות שחושבו (`totalPurchaseUSD, totalPurchaseILS, totalCurrentValueUSD, currentExchangeRate, totalCurrentValueILS, profitUSD, profitILS, adjustedCostBasisILS, realGainILS, currencyExemptGainILS, taxUSD, taxILS, afterTaxUSD, afterTaxILS, exchangeRateImpact`).

מקרי קצה מכוסים: אובייקט ריק (הכל מתנהג כ-0 ללא שגיאה); הפסד (`profitUSD < 0` → `taxUSD = 0` כי `calculateLinkedRealResult` לא מטילה מס על רווח שלילי); `currentExchangeRate` חסר (נופל חזרה ל-`exchangeRate`); `taxRate` מותאם אישית; מקרים שבהם יש רווח נומינלי שלילי (הפסד) אך רווח ריאלי חיובי (עקב פיחות משמעותי של השקל) - במקרה זה כן חל מס אף שהתמונה הנומינלית מראה הפסד; ולהיפך - מקרה שבו ההפסד הדולרי וההתחזקות בשער "מסכימות" על הפסד - ההפסד הריאלי אינו "מוגדל" מעבר להפסד הנומינלי (150-).

**`sumDepositsInRange(deposits, fromDateExclusive, toDateInclusive)`**

מסכמת שדה `amount` מתוך מערך הפקדות (`{date, amount}[]`) שנופלות בטווח **פתוח מלמטה, סגור מלמעלה**: `(fromDateExclusive, toDateInclusive]`. כלומר הפקדה בתאריך `fromDateExclusive` בדיוק **לא** נכללת (`d.date <= fromDateExclusive` → מדולגת), אך הפקדה בתאריך `toDateInclusive` בדיוק **כן** נכללת. אם `fromDateExclusive` חסר/falsy - כל ההפקדות עד `toDateInclusive` נכללות (מתאים למקרה של קופה חדשה בלי "עדכון קודם"). מקרי קצה: קלט לא-מערך → `0`; הפקדה בלי `date` → מדולגת בביטחה.

**`applyPensionValueUpdate(pensionFund, newCurrentValue, newCurrentValueDate)`**

"סוגר תקופה" עבור קופת גמל: מזיז את הצמד `(currentValue, currentValueDate)` הישן ל-`(previousValue, previousValueDate)`, וקובע ערכים חדשים במקומם. `oldCurrentValue = pensionFund.currentValue ?? pensionFund.amount ?? 0` (תאימות לאחור לשם שדה ישן `amount`). שדות אחרים באובייקט (כמו `deposits`) נשמרים ללא שינוי (spread `...pensionFund`). שדה `amount` מסונכרן גם הוא לערך החדש (כפילות תואמת-אחור).

**`applyPensionValueEditPayload(pensionFund, payload)`**

עטיפת UI סביב `applyPensionValueUpdate`: אם `payload` הוא אובייקט עם `date`, משתמש ב-`{value, date}` שסופקו; אחרת (מספר בודד, נפילה הגנתית) - משתמש בו כערך, עם תאריך = היום (`new Date().toISOString().slice(0,10)`).

**`calculatePensionPeriodReturn(pensionFund)`**

מחשבת תשואת-תקופה (מעדכון קודם לעדכון נוכחי) המנוטרלת מהפקדות שבוצעו בתקופה עצמה - כדי שכסף חדש שהוזרם לקופה לא "יתחזה" לרווח:
1. `currentValue = pensionFund.currentValue ?? pensionFund.amount ?? 0`
2. `previousValue = pensionFund.previousValue ?? 0`
3. `depositsInPeriod = sumDepositsInRange(deposits, previousValueDate, currentValueDate)` - כל ההפקדות שנופלות בדיוק בטווח שבין העדכון הקודם לנוכחי (לפי הכללים לעיל).
4. `adjustedPreviousValue = previousValue + depositsInPeriod`
5. **`percent = adjustedPreviousValue > 0 ? ((currentValue / adjustedPreviousValue) - 1) * 100 : 0`**

הנוסחה: התשואה מחושבת כאילו ה"בסיס" האמיתי לתקופה הוא השווי הקודם בתוספת ההפקדות שנכנסו בתקופה (ולא רק השווי הקודם הגולמי), כך שרק הצמיחה בפועל (עלייה/ירידה בשווי השוק) נמדדת, בלי לספור הפקדות טריות כרווח. פלט: `{ adjustedPreviousValue, depositsInPeriod, percent }`. מקרה קצה: `adjustedPreviousValue <= 0` (קופה חדשה בלי ערך קודם) → `percent = 0`.

**`hasAmbiguousPensionPeriod(pensionFund)`**

דגל אבחוני (לא חישוב כספי) שמזהה מצב "תקופה מנוונת": כאשר `previousValueDate === currentValueDate` (שני התאריכים שווים ולא ריקים). זהו מצב באג פוטנציאלי: אם התאריך שאמור לסמן את *תחילת* התקופה שווה בטעות לתאריך *סוף* התקופה, כל הפקדה שבוצעה *לפני* אותו תאריך המשותף (לא משנה לפני כמה זמן) תיפול מחוץ לטווח `(fromDateExclusive, toDateInclusive]` ותוחרג בשקט מ"מאז העדכון הקודם" - מה שמנפח את התשואה המוצגת. מחזירה `false` אם אחד התאריכים חסר, או על קלט `undefined`/`null` (ללא זריקת שגיאה).

---

### `src/utils/portfolioMath.test.js`

בודק את כל הפונקציות ב-`portfolioMath.js`:
- **`calculateAmericanStockMetrics`**: המרות דולר/שקל בסיסיות (1000$→3500 ש"ח בשער 3.5); `profitILS` הוא הנומינלי האמיתי (5550-3500=2050) ולא `profitUSD*currentExchangeRate`; מס רק על רווח חיובי (125$=500*0.25), אין מס על הפסד; נפילה חזרה ל-`exchangeRate` כש-`currentExchangeRate` חסר; `exchangeRateImpact` מבודד את הרווח/הפסד הנובע מהשער בלבד (150*10*(3.7-3.5)=300), ו-0 כשהשער לא זז; התנהגות הגנתית על אובייקט ריק; פירוק ריאלי/פטור-ממטבע שסכומם תמיד שווה לנומינלי; **מקרה מציאותי**: מניה שהניבה רווח דולרי אמיתי (192$→213.05$) אך הפסד נומינלי בשקלים (עקב פיחות שער חד מ-3.7 ל-2.96) - עדיין חייבת במס למרות ההפסד הנומינלי; שני מקרי פסיקת מוזס: הפסד נומינלי + התחזקות שקל → הפסד ריאלי לא מוגדל (150- ולא 350-), ורווח נומינלי + פיחות שקל → מוסה במלואו בלי הקלה (רווח ריאלי 100, לא 300).
- **`sumDepositsInRange`**: טווח פתוח-סגור מדויק (הפקדה בגבול התחתון לא נכללת); ברירת מחדל בלי `fromDateExclusive`; התנהגות על מערך לא-תקין/הפקדה בלי תאריך.
- **`applyPensionValueUpdate`**: הזזת הצמד הישן, נפילה חזרה ל-`amount`/מחרוזת ריקה, ואי-נגיעה ב-`deposits`.
- **`applyPensionValueEditPayload`**: משתמש בתאריך שסופק, לא בהיום; נפילה חזרה למספר בודד + תאריך היום.
- **`calculatePensionPeriodReturn`**: מקרה מרכזי - הפקדה של 10,000 בתוך התקופה מנוטרלת (תשואה 0.909% על 111,000 מתוך 110,000 מתואם, לא 11%); הפקדה לפני/אחרי התקופה מוחרגת נכון; קופה חדשה בלי ערך קודם → 0%.
- **`hasAmbiguousPensionPeriod`**: מקרה רגרסיה אמיתי (35,000 ש"ח שהוחרגו בשקט כש-`previousValueDate=currentValueDate`); לא מסמן תקופה אמיתית; מתמודד עם קלט חסר/null.

---

### `src/utils/portfolioStats.js`

#### תפקיד

מודול הסטטיסטיקה ההיסטורית של התיק, המבוסס על תמונות-מצב (snapshots) יומיות שנשמרות בפועל (ולא על נקודת-זמן בודדת כמו שאר החישובים). לפני מודול זה, לא היה לאפליקציה שום מדד אמיתי ל"איך התיק התנהג עם הזמן" - תנודתיות, שארפ, דרוודאון מקסימלי. המדדים דורשים כמות מינימלית של תמונות-מצב כדי להיות משמעותיים, ומחשבים ("ימים" קלנדריים לא-אחידים, כי תמונות-מצב נלקחות רק כשהמשתמש פותח את האפליקציה, לא לפי יומי-מסחר).

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`buildEquitySeries(snapshots)`**

מנרמל שורות snapshot גולמיות (מ-`GET /api/portfolio-snapshots`) לסדרה נקייה ומסודרת `{date, value}[]`: מסנן שורות בלי `date` תקין או `totalValueILS` לא-מספרי (`Number.isFinite`), ואז ממיין לפי תאריך (מחרוזתי, עולה). קלט לא-מערך → `[]`.

**`daysBetween(d1, d2)`** (פרטית, לא מיוצאת)

`(b - a) / (1000*60*60*24)`, כאשר `> 0`; אחרת מחזירה `0.5` (הגנה מפני כפילויות בתאריך זהה/סטיית שעון).

**`computeMaxDrawdown(series)`**

מוצאת את הנפילה הגדולה ביותר משיא לתחתית (Peak-to-Trough), כאחוז חיובי. אלגוריתם: מעבר יחיד על הסדרה, שומר "שיא רץ" (`peak`) שמתעדכן כל פעם שהערך הנוכחי גבוה ממנו; בכל נקודה מחשבים `dd = (peak - point.value) / peak` (אם `peak > 0`), ומעדכנים `maxDD` אם זה השיא. פלט: `{ maxDrawdownPercent: maxDD*100, peakDate, troughDate }` - התאריכים של השיא ותחתית הדרוודאון המקסימלי (לא בהכרח האחרון!). קלט ריק → `{0, null, null}`.

**`computePeriodReturns(series)`**

מייצרת תשואות בין נקודות עוקבות: `periodReturn = curr.value/prev.value - 1`, בתוספת `days = daysBetween(prev.date, curr.date)`. מדלגת על תקופות שבהן `prev.value <= 0` (הגנה מחלוקה באפס/שלילי). סדרה עם נקודה אחת → `[]`.

**`dailyEquivalentStats(returns)`** (פרטית - הבסיס המשותף לתנודתיות ולשארפ)

ממירה כל תשואת-תקופה לתשואה "יומית-שקולה": `dailyEquivalent = (1+periodReturn)^(1/days) - 1`, כדי שתקופות בגדלים לא-אחידים (כתוצאה מ-snapshots לא רציפים) יהיו ניתנות להשוואה על בסיס אחיד. אז מחושב:
- `mean = Σ dailyEquivalents / n`
- `variance = Σ (v - mean)² / max(n-1, 1)` (שונות מדגמית, מכנה n-1 עם הגנה מ-0)
- `stdev = sqrt(variance)`

**`computeVolatilityPercent(returns)`**

תנודתיות שנתית (%): `stdev * sqrt(252) * 100` - סקאלה סטנדרטית לפי 252 ימי מסחר בשנה (אף שה"ימים" כאן הם ימים קלנדריים לא-אחידים - קירוב מוצהר, לא נתון שוק אמיתי). דורשת לפחות 2 תשואות (`returns.length >= 2`), אחרת `null`.

**`computeSharpeRatio(returns, riskFreeAnnualPercent = 0)`**

מדד שארפ שנתי: `(annualizedReturn - riskFreeAnnualPercent/100) / annualizedStdev`, כאשר:
- `annualizedReturn = (1+mean)^252 - 1`
- `annualizedStdev = stdev * sqrt(252)`

מחזירה `null` אם יש פחות מ-2 תשואות, או אם `stdev === 0` (סדרה שטוחה לחלוטין - אין שונות לחלק בה).

**`computeBestWorstPeriod(returns)`**

ממיינת את מערך התשואות לפי `periodReturn` עולה, ומחזירה `{worst: sorted[0], best: sorted[last]}`. מערך ריק → `{null, null}`.

**`MIN_SNAPSHOTS_FOR_RISK_STATS = 5`** - קבוע: מתחת לכמות זו, תנודתיות/שארפ נחשבים "רועשים מכדי להציג" (אך עקומת ההון ודרוודאון מוצגים כבר מ-2 נקודות).

**`computePortfolioStats(snapshots, riskFreeAnnualPercent = 0)`**

הפונקציה המאחדת: בונה `series`, `returns`, ומחשבת דרוודאון + best/worst תמיד (אם יש 2+ נקודות), אבל תנודתיות/שארפ רק אם `series.length >= 5`. `totalReturnPercent = (last.value/first.value - 1)*100` (רק אם 2+ נקודות ו-`series[0].value > 0`, אחרת `null`). פלט מלא: `{ series, hasHistory (≥2), hasEnoughForRiskStats (≥5), snapshotsCount, firstDate, lastDate, totalReturnPercent, maxDrawdownPercent, drawdownPeakDate, drawdownTroughDate, volatilityPercent, sharpeRatio, bestPeriod, worstPeriod }`.

---

### `src/utils/portfolioStats.test.js`

בודק את כל שרשרת הפונקציות: `buildEquitySeries` ממיינת ומנקה שורות פסולות (תאריך חסר/ערך לא-מספרי) ומתמודדת עם קלט לא-מערך; `computeMaxDrawdown` מוצא 0 לסדרה עולה מונוטונית, ומוצא נכון את הנפילה הגדולה מ-200→100 (50%) ולא את הנפילה המאוחרת יותר הקטנה יותר (150→120, 20%), עם התאריכים הנכונים; `computePeriodReturns` מחשב 10% תשואה על 10 ימים כ-`(0.1, 10)`, ומחזיר `[]` לנקודה בודדת; `computeVolatilityPercent`/`computeSharpeRatio` דורשים 2+ תשואות (3 snapshots), סדרה שטוחה לחלוטין (צמיחה קבועה 1%/יום) נותנת תנודתיות ~0 ו-Sharpe null (אין שונות), וסדרה תנודתית באמת נותנת תנודתיות חיובית; `computeBestWorstPeriod` בוחר את התשואה החיובית/שלילית הגדולה ביותר; `computePortfolioStats` בודק שלב-שלב: פחות מ-2 snapshots → `hasHistory=false` וכל מדדי הסיכון `null`; 2 snapshots → תשואה כוללת מחושבת (10%) אבל מדדי סיכון עדיין null (דורשים 5+); 5 snapshots → הכל מחושב, כולל דרוודאון 25% (120→90).

---

### `src/utils/portfolioAnalysis.js`

#### תפקיד

מנוע ניתוח התיק המלא: פילוח לפי בורסה (ישראלי/אמריקאי/גמל/קרנות כספיות/עו"ש/חיסכון בנקאי), פילוח לפי מניה בודדת (עם קיבוץ lots), פילוח לפי תאריך רכישה (חודשי/שנתי), ודוחות "מובילים/מפגרים/פוזיציות גדולות". חולץ במקור מ-`App.js`'s `calculatePortfolioAnalysis()` - התנהגות זהה, רק שהמערכים מועברים כפרמטרים מפורשים במקום מצב-קומפוננטה סגור.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`calculatePortfolioAnalysis(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds = [])`**

פונקציה יחידה מיוצאת, ענקית, שמחשבת כמה תת-מבנים:

**1. `daysBetween(rawDate)` (פרטית):** `Math.floor((now - new Date(rawDate)) / (1000*60*60*24))`, עם `Math.max(days, 0)` (לא מאפשר ימים שליליים אם התאריך בעתיד) ו-`NaN` → 0.

**2. חישוב שווי כולל לכל קטגוריה:**
- `israeliTotalValue = Σ normalizeIsraeliPrice(currentPrice) * quantity`
- `americanTotalValueILS = Σ calculateAmericanStockMetrics(stock).totalCurrentValueILS`
- `pensionTotalValueILS = Σ (currentValue ?? amount)`
- `cashFundsTotalValueILS = Σ amount`
- `bankTotalValueILS = Σ amount`
- `bankSavingsTotalValueILS = Σ computeBankSavingsFundValue(fund)`
- `totalValueILS` = סכום כל השישה.

**3. `stockDistribution` - קיבוץ מניות לפי `stockName` (מאחד lots מרובים לאותה מניה):**

לכל מניה בודדת (ישראלית/אמריקאית), עבור כל lot:
- `value`, `purchaseValue`, `profit = value - purchaseValue` (מחושב לפי `normalizeIsraeliPrice` למניה ישראלית, או `calculateAmericanStockMetrics` למניה אמריקאית).
- `daysHeld = daysBetween(purchaseDate)`, `yearsHeld = daysHeld/365`.
- מצטבר לתוך רשומת ה-stock המקובצת: `value += value`, `profit += profit`, `totalQuantity += quantity`, `totalPurchaseValue += purchaseValue`.
- **`totalWeightForYears += purchaseValue`** ו-**`weightedYearsNumerator += yearsHeld * purchaseValue`** - אלה בונים ממוצע-משוקלל של `yearsHeld` על פני כל ה-lots (משוקלל לפי סכום הרכישה של כל lot) - כלומר lot גדול משפיע יותר על "כמה שנים בממוצע המניה מוחזקת" מ-lot קטן.
- `daysHeld`/`yearsHeld` (הגולמיים, ברמת lot) מתעדכנים ל-`Math.max` (השיא בין כל ה-lots, לפני החישוב המשוקלל).
- `dailyChange` מוחלף כל פעם (לא מצטבר) לערך ה-`dailyChangePercent` של ה-lot האחרון שעובד.
- אם `yearsHeld > 0 && purchaseValue > 0`: `annualizedReturn = (value/purchaseValue)^(1/yearsHeld) - 1` (תשואה שנתית מגולמת, CAGR, לפי lot בודד - **מוחלפת** בהמשך).

**4. חשבון נגזרות סופיות, לאחר איחוד כל ה-lots לכל מניה:**
- `percentage = value / totalValueILS * 100`
- `profitPercentage = profit / totalPurchaseValue * 100`
- `avgPurchasePrice = totalPurchaseValue / totalQuantity` (מחיר קנייה ממוצע משוקלל-כמות)
- **`yearsHeld = weightedYearsNumerator / totalWeightForYears`** (אם `totalWeightForYears > 0`) - ממוצע `yearsHeld` **משוקלל לפי שווי-רכישה** על פני כל ה-lots שנקבצו, לא ממוצע פשוט.
- `daysHeld = round(yearsHeld * 365)`
- **`annualizedReturn = (value/totalPurchaseValue)^(1/yearsHeld) - 1`** (אם `yearsHeld > 0 && totalPurchaseValue > 0`) - תשואה שנתית מגולמת (CAGR) על **המניה המאוחדת** (כל ה-lots יחד), לא רק ה-lot האחרון.
- **`volatility = |dailyChange| * 1.5`** - קירוב גס-מאוד ("simplistic volatility approximation", כלשונו בקוד) שאינו מבוסס על שונות אמיתית - רק שינוי יומי אחוזי מוכפל ב-1.5. (מודול `portfolioStats.js` מציע חלופה אמיתית מבוססת snapshots).

**5. פילוח לפי תאריך (`monthlyDistribution`, `yearlyDistribution`):**

`addDateBucket(stock, value)` בונה מפתח חודשי `"YYYY-MM"` ומפתח שנתי מ-`purchaseDate` (אם התאריך לא תקין - `NaN` - מדלגת בשקט), ומצטברת `{value, count}` בכל דלי. מיושם לכל שש הקטגוריות (עם "תאריך רכישה" מלאכותי לקטגוריות שאינן מניה - `updateDate` לגמל/קרנות/עו"ש, תאריך ההפקדה האחרונה לחיסכון בנקאי).

**6. דוחות מפורטים (מבוססי `stockList = Object.values(stockDistribution)`):**
- `topPerformers`: מניות עם `profit > 0`, ממוינות לפי `profit` יורד, מוגבל ל-5.
- `worstPerformers`: מניות עם `profit < 0`, ממוינות לפי `profit` עולה (הכי גרוע ראשון), מוגבל ל-5.
- `largestPositions`: כל המניות ממוינות לפי `value` יורד, מוגבל ל-5.

**7. מדדי סיכום (`summaryMetrics`):**
- `totalPurchaseILS = Σ totalPurchaseValue` (על פני stockList בלבד)
- `totalProfitILS = Σ profit`
- **`weightedDailyChangePercent = Σ(dailyChange * value) / totalValueILS`** - שינוי יומי משוקלל-שווי על פני כל המניות.
- **`weightedAnnualizedReturnPercent = [Σ(annualizedReturn * totalPurchaseValue) / totalPurchaseILS] * 100`** - תשואה שנתית מגולמת משוקללת-עלות-רכישה.
- **`concentrationTop3Percent`** - סכום ה-`percentage` של שלוש הפוזיציות הגדולות ביותר (לפי `value`) - מדד ריכוזיות המשמש גם ב-`portfolioHealthScore.js`.
- `averageHoldingDays = round(Σ daysHeld / stockList.length)` - ממוצע פשוט (לא משוקלל) בין המניות המאוחדות.
- `americanFxImpactILS = Σ calculateAmericanStockMetrics(stock).exchangeRateImpact` (סכום גולמי, ברמת lot, לא ברמת מניה מאוחדת).
- `israeliPositions`/`americanPositions` = ספירת מניות מאוחדות (לא lots) לפי `exchange`.
- `nonStockTotalValueILS = pension + cashFunds + bank + bankSavings`.

**8. פלט סופי:** `{ exchangeDistribution: {israeli, american, pension, cashFunds, bank, bankSavings, total} (כל אחד עם value+percentage), stockDistribution (ממוין יורד לפי value), monthlyDistribution, yearlyDistribution, reports: {topPerformers, worstPerformers, largestPositions}, summaryMetrics: {...} }`.

מקרי קצה: תיק ריק → כל הערכים 0/מערכים ריקים; שדות מספריים חסרים (`{stockName: 'A'}` בלי quantity/price) → לא נזרקת שגיאה, הכל מטופל כ-0.

---

### `src/utils/portfolioAnalysis.test.js`

בודק: תיק ריק לא זורק שגיאה; שני lots של אותה מניה (TEVA) מתאחדים לרשומה אחת עם `totalQuantity=150`; אחוזי `exchangeDistribution` מסתכמים ל-100%; מניה עם רווח מסווגת כ-topPerformer ומניה עם הפסד כ-worstPerformer (בלעדית); `largestPositions` ממוין נכון (יורד לפי value); `positionsCount` כולל כל הקטגוריות (מניות מאוחדות + גמל + קרנות + עו"ש); שדות מספריים חסרים לא זורקים שגיאה; **קופות חיסכון בנקאי** (`bankSavingsFunds`) - קרן חדשה עם הפקדה של 4000 תורמת נכון ל-`exchangeDistribution.bankSavings` (100% מהתיק אם זה כל התיק), ואחוזי כל שש הקטגוריות מסתכמים ל-100% גם עם `bankSavings`; קריאה ללא הפרמטר (תאימות לאחור) מתייחסת אליו כריק.

---

### `src/utils/modifiedDietz.js`

#### תפקיד

מיישם את "תשואת דיץ המתוקנת" (Modified Dietz Return) - קירוב תעשייתי סטנדרטי (לפי תקני GIPS) לתשואת תיק על פני תקופה שכללה זרימות מזומן חיצוניות (הפקדות/משיכות) באמצע התקופה - כך שהפקדה באמצע התקופה לא נספרת כצמיחת השקעה, וככל שזרימת המזומן קרובה יותר לסוף התקופה, היא מקבלת "קרדיט"/"אשם" קטן יותר על השינוי האחוזי הכולל. זהו אינו תשואה משוקללת-זמן יומית מלאה (שדורשת שווי בכל תאריך זרימת מזומן) - זה הקירוב הטוב ביותר האפשרי משווי תחילת/סוף תקופה בתוספת רשימה מתוארכת של זרימות.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**הנוסחה הכללית (מתועדת בהערת הכותרת):**

```
R = (EMV - BMV - CF) / (BMV + Σ CF_i * w_i)
```
כאשר `EMV`/`BMV` = שווי שוק בסוף/בתחילת התקופה, `CF_i` = כל זרימת מזומן חיצונית (+ הפקדה, - משיכה), ו-`w_i = (periodEnd - date_i) / (periodEnd - periodStart)` - החלק (השבר) מהתקופה שבו הכסף **לא** היה עדיין מושקע (זרימה ביום הראשון מקבלת משקל ~1, זרימה ביום האחרון מקבלת משקל ~0).

**`modifiedDietzWeight(periodStart, periodEnd, flowDate)`**

מחשבת את `w_i` לזרימת מזומן בודדת: `start`, `end`, `flow` מומרים ל-milliseconds. אם אחד מהם לא-מספרי (`!Number.isFinite`) או `end <= start` (תקופה באורך אפס/שלילי) → `0`. אחרת: `clamped = min(max(flow, start), end)` (**קיבוץ** - clamp - תאריך זרימה שמעבר לגבולות התקופה נדחס לגבול הקרוב, לא מאקסטרפלט מעבר לו). `return (end - clamped) / (end - start)`.

בדיקה מהירה: זרימה ב-`periodStart` בדיוק → `clamped=start` → `w=(end-start)/(end-start)=1`. זרימה ב-`periodEnd` בדיוק → `clamped=end` → `w=0`. זרימה בדיוק באמצע → `w=0.5`.

**`calculateModifiedDietzReturn({ beginningValue = 0, endingValue = 0, cashFlows = [], periodStart, periodEnd })`**

`cashFlows`: `[{date, amount}]` - חיובי = כסף שנכנס (הפקדה/רכישה), שלילי = כסף שיצא (משיכה/מכירה). כרגע האפליקציה מייצרת רק זרימות חיוביות (אין עדיין פנקס מכירות/משיכות), אך הנוסחה תומכת בשני הכיוונים.

1. `netCashFlow = Σ cf.amount`
2. `weightedCashFlow = Σ cf.amount * modifiedDietzWeight(periodStart, periodEnd, cf.date)`
3. `denominator = beginningValue + weightedCashFlow`
4. `gain = endingValue - beginningValue - netCashFlow`
5. `percent = denominator !== 0 ? (gain/denominator)*100 : null` (הגנה מפני `Infinity`/`NaN`)

פלט: `{netCashFlow, weightedCashFlow, gain, percent}`.

הגיון: `gain` הוא הרווח ה"אמיתי" (לא כולל את הכסף שהוזרם, ולא כולל את הכסף שנמשך - כלומר צמיחת שוק בלבד). המכנה מתאים את בסיס ההשקעה כך שכל זרימת מזומן "נספרת" רק לפי החלק מהתקופה שבו היא בפועל הייתה מושקעת (משוקלל לפי `w_i`) - כדי שהתשואה תשקף נכון את קצב הצמיחה גם כשהיו הפקדות/משיכות באמצע.

---

### `src/utils/modifiedDietz.test.js`

בודק: `modifiedDietzWeight` נותן 1/0/0.5 לזרימה בתחילה/סוף/אמצע התקופה; מקבע (clamp) תאריך שמחוץ לתקופה לגבול הקרוב; מחזיר 0 לתאריך לא-תקין או תקופה באורך אפס, בלי לזרוק שגיאה. `calculateModifiedDietzReturn`: ללא זרימות מזומן - שווה לשינוי אחוזי פשוט (10%); **המקרה המרכזי (תיקון באג)** - הפקדה של 10,000 באמצע החודש עם צמיחה אמיתית 0% נותנת ~0% (לא 10% הנאיבי); הפקדה ביום 1 (משקל 1) נכללת במלואה במכנה כך שצמיחה על גביה נמדדת נכון (10%); הפקדה ביום האחרון בקושי משפיעה על התשואה למרות ש-EMV קפץ (0.5% ולא הזינוק המלא); משיכה (זרימה שלילית) מנוטרלת סימטרית; מספר זרימות כל אחת משוקללת בנפרד; מכנה אפס מחזיר `null` ולא `Infinity`/`NaN`; קלט חסר לא זורק שגיאה.

---

### `src/utils/portfolioSummary.js`

#### תפקיד

מנוע סיכום התיק המלא - כולל מיסוי רווח הון ריאלי המוצמד למדד המחירים לצרכן (CPI) כשזמין, עם נפילה חזרה למס שטוח על הרווח הנומינלי כשלא. חולץ מ-`App.js`'s `calculatePortfolioSummary()`. זהו הקובץ שבו כל שדות "הסיכום הכולל" של התיק (סה"כ שווי, סה"כ רווח, סה"כ מס, פירוק ריאלי/אינפלציוני) מחושבים בפועל. מקבל אופציונלית `cpi = { currentIndex, indexByMonth }` - אם המדד לא נטען (או שהמשיכה מהשרת נכשלה), האפליקציה ממשיכה לעבוד עם מס שטוח פשוט על הרווח הנומינלי.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`calculatePortfolioSummary(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, cpi = {}, bankSavingsFunds = [])`**

**1. מניות ישראליות (`israeliSummary`, reduce על כל lot):**
- `totalPurchase = purchasePrice * quantity`
- `totalCurrentValue = normalizeIsraeliPrice(currentPrice) * quantity`
- `profit = totalCurrentValue - totalPurchase`
- `indexAtPurchase = indexByMonth[monthKeyFromDate(purchaseDate)]`
- **אם `currentIndex && indexAtPurchase` זמינים:** `calculateStockRealGainTax({purchasePrice, quantity, currentValue: totalCurrentValue, indexAtPurchase, currentIndex})` נותן `{tax, realGain}` (ראו `cpiTax.js`). `inflationaryGain = profit - realGain` (נגזר כ"מה שנשאר" מהנומינלי - **לא** חישוב עצמאי, כדי להתאים תמיד לכלל האסימטרי, כולל במקרי קצה).
- **אחרת (fallback, אין מדד לתאריך הקנייה):** `stockTax = profit > 0 ? profit * TAX_RATE : 0`; `realGain = profit`; `inflationaryGain = 0`.
- מצטבר: `totalPurchaseILS`, `totalCurrentValueILS`, `totalProfitILS`, `totalTaxILS`, `totalRealGainILS`, `totalInflationaryGainILS`, `totalWeight` (=`totalCurrentValueILS`, לשימוש בממוצע משוקלל), `dailyChangeSum += dailyChangePercent * totalCurrentValue`.

**2. מניות אמריקאיות (`americanSummary`):** מפעילה `calculateAmericanStockMetrics(stock)` על כל lot ומצטברת את כל 12 השדות שלה (USD/ILS פורצ'יס/וקרנט/פרופיט/מס/ריאלי/פטור-ממטבע/פקס-אימפקט), בתוספת `totalWeight` ו-`dailyChangeSum` לממוצע משוקלל.

**3. שינוי יומי משוקלל:**
- `totalWeight = israeliSummary.totalWeight + americanSummary.totalWeight`
- `weightedDailyChange = (israeliSummary.dailyChangeSum + americanSummary.dailyChangeSum) / totalWeight` (0 אם `totalWeight <= 0`)
- `dailyProfitILS = (weightedDailyChange/100) * (israeliCurrentValue + americanCurrentValueILS)`
- `dailyProfitUSD = (weightedDailyChange/100) * americanCurrentValueUSD`
- בנוסף, `israeliDailyProfitILS`/`americanDailyProfitUSD` מחושבים **בנפרד** (לא מ-`weightedDailyChange` הכולל, אלא ישירות): `Σ (dailyChangePercent/100) * currentValue` על כל lot בקטגוריה שלו.

**4. סיכומי מניות ישראליות/אמריקאיות בנפרד:**
- `israeliProfitILS = totalCurrentValueILS - totalPurchaseILS`; `israeliTaxILS = israeliSummary.totalTaxILS` (כבר חושב per-stock); `israeliAfterTaxILS = profit - tax`; `israeliProfitPercent = profit/purchase*100`; `israeliDailyPercent = dailyProfit/currentValue*100`.
- אנלוגי במלואו למניות אמריקאיות (`americanProfitUSD`, `americanTaxUSD`, וכו') - כולל `americanTaxILS = americanSummary.totalTaxILS` (סכום ה-lots, **לא** חישוב מחדש ברמת תיק - כי ל-lots שונים יכולים להיות שערי חליפין נוכחיים שונים, מה שהיה נותן תוצאה שגויה אם היו מסכמים תחילה ורק אז מחשבים מס).

**5. קרנות כספיות/עו"ש:** `cashFundsTotalILS = Σ amount`; `bankBalancesTotalILS = Σ amount`.

**6. קופות גמל:**
- `pensionInitialInvestmentILS = Σ Σ deposits[].amount` (סכום כל ההפקדות לכל הקופות - **תמיד** נגזר מפנקס ההפקדות, לא שדה ידני, בדיוק כמו "סה"כ רכישה" במניות).
- `pensionCurrentValueILS = Σ (currentValue ?? amount ?? 0)`; `pensionPreviousValueILS = Σ (previousValue ?? amount ?? 0)`.
- **`pensionProfitPercent = (currentValue/initialInvestment - 1) * 100`** - מדד עזר "רווח מצטבר מול הפקדות", **לא** תשואה אמיתית (הפקדות בתאריכים שונים מטופלות כאילו כולן בוצעו ביום הראשון - הטיה כלפי מטה כשיש הפקדות טריות).
- **`pensionAdjustedPreviousValueILS = Σ calculatePensionPeriodReturn(fund).adjustedPreviousValue`** (מ-`portfolioMath.js`) - מנטרל הפקדות שבוצעו בתוך התקופה מ"עדכון לעדכון".
- `pensionPreviousProfitPercent = (currentValue/adjustedPreviousValue - 1)*100`, עם נפילה חזרה ל-`pensionProfitPercent` אם `adjustedPreviousValue <= 0`.
- `pensionTotalProfitILS = currentValue - initialInvestment`.
- **מיסוי (`pensionTaxILS`, `pensionRealGainILS`, `pensionInflationaryGainILS`):**
  - **אם `currentIndex` זמין:** לכל קופה, `calculatePensionRealGainTax({deposits, currentValue, currentIndex, indexByMonth})` (ראו `cpiTax.js`) - מוצמד תמיד (ללא ברירת "שטוח") כי כל קופת גמל ממוסה על הרווח הריאלי, ללא קשר למסלול השקעה. `pensionTaxILS = Σ tax`, `pensionRealGainILS = Σ gain`. `pensionInflationaryGainILS = pensionTotalNominalILS - pensionRealGainILS` (נגזר כשארית, לא עצמאי) כאשר `pensionTotalNominalILS = Σ(currentValue - totalDeposited)`.
  - **אחרת (fallback ללא CPI):** `pensionTaxILS = totalProfit>0 ? totalProfit*TAX_RATE : 0`; `pensionRealGainILS = totalProfit`; `pensionInflationaryGainILS = 0`.
- `pensionUpdateProfitILS = currentValue - previousValue` (גולמי, לא מנוטרל הפקדות).

**7. קופות חיסכון בבנק:**
- `bankSavingsInitialInvestmentILS = Σ Σ deposits[].amount`; `bankSavingsCurrentValueILS = Σ computeBankSavingsFundValue(fund)` (ראו `bankSavingsFund.js` - ריבית-דריבית אוטומטית).
- `bankSavingsTotalProfitILS = current - initial`.
- לכל קרן: `calculateBankSavingsFundTax({deposits, currentValue, isLinkedToIndex, currentIndex, indexByMonth})` - 15% שטוח על הנומינלי (לא מוצמדת) או 25% על הריאלי (מוצמדת), תלוי בבחירת מסלול ההשקעה בפועל של הקרן (ראו `cpiTax.js`).

**8. סיכום סופי (מוחזר):**
- `totalTaxILS = israeliTax + americanTax(ILS) + pensionTax + bankSavingsTax`
- `totalProfitAfterTaxILS = (israeliProfit + americanProfit(ILS) + pensionProfit + bankSavingsProfit) - totalTaxILS`
- `totalRealGainILS = israeliReal + americanReal + pensionReal + bankSavingsReal`
- `totalInflationaryGainILS = israeliInflationary + americanCurrencyExempt + pensionInflationary` (**שים לב**: לא כולל bankSavingsInflationary - לא קיים שדה כזה מפורש בפלט)
- `capitalTotalILS = capitalIsraeli + capitalAmerican + cashFunds + pensionCurrent + bankBalances + bankSavingsCurrent`

הפלט כולל עשרות שדות בשמות מפורשים (ראו קוד למספרים המדויקים) - כולם נגזרים מ-8 החישובים לעיל, ללא חישוב נוסף מעבר לכך.

מקרי קצה: תיק ריק → כל השדות 0; הפסד → אין מס; שדות מספריים חסרים לא זורקים שגיאה; ה-CPI חסר לחלוטין → מס שטוח בכל מקום; ה-CPI זמין אבל אין ערך מדד לחודש הרכישה הספציפי → נופל חזרה למס שטוח **לאותה מניה בלבד**.

---

### `src/utils/portfolioSummary.test.js`

בודק: תיק ריק מחזיר סיכום כולו-אפס; מניה ישראלית רווחית - מס 25% על הרווח הנומינלי (ללא CPI); הפסד לא ממוסה; מניות אמריקאיות מומרות נכון ל-ILS ומצטרפות לסה"כ; **פטור ממס בגלל שער** - כשמחיר המניה לא זז אבל השער עלה, כל הרווח בשקלים פטור (`realGainILS≈0`, `taxILS=0`, `currencyExemptGainILS=1500*(3.9-3.6)=450`); גמל/קרנות/עו"ש נכללים ב-`capitalTotalILS`; חישוב מסכם על תיק מעורב; שדות חסרים לא זורקים שגיאה; **קופות חיסכון בבנק**: מסלול לא-צמוד (15% על נומינלי, ריבית 0% → אין רווח → אין מס), מסלול צמוד (25% על ריאלי, עם עלייה במדד שיכולה לגרום להפסד נומינלי ולכן ל-0 מס), והשתלבות ב-`capitalTotalILS`; קריאה בלי `bankSavingsFunds` (תאימות לאחור); **מס רווח הון ריאלי (CPI)**: מניה ישראלית שכל הרווח הנומינלי שלה הוא בדיוק אינפלציה (מדד עלה 30%, מחיר עלה 30%) → אין מס; חסר מדד לחודש הרכישה הספציפי → נופל למס שטוח; קופת גמל - 25% על הרווח הריאלי, כל הפקדה מוצמדת בנפרד (`adjustedCost = 50000*(130/100) + 20000*(130/115)`); בלי CPI כלל - נופל חזרה למס שטוח 25%; פירוקי ריאלי/אינפלציוני שסכומם תמיד = הנומינלי; **מקרה רגרסיה** - מדד שירד (הצמדה כלפי מטה) → כל הרווח חייב, `inflationaryGain=0` ולא שלילי; סכומים כוללים על פני כל הקטגוריות; ותשואת-תקופה של גמל שמנטרלת הפקדה בתוך התקופה אוטומטית.

---

### `src/utils/portfolioHealthScore.js`

#### תפקיד

מחשב מדד יחיד מורכב (0-100) של "בריאות התיק", הבנוי משילוב מדדים שהאפליקציה מחשבת במקומות אחרים: ריכוזיות (`portfolioAnalysis.js`), ריכוזיות סקטור (`sectorAnalysis.js`), קורלציה בין אחזקות (`correlationAnalysis.js`), תנודתיות/דרוודאון (`portfolioStats.js`), וסטייה מיעדי איזון (`rebalancing.js`). זהו היוריסטיקה לכיוון מהיר ("איזה מנוף הכי גרוע כרגע") - **לא** ייעוץ פיננסי או מדד סיכון מאושר מדעית. תת-מדד שהנתונים שלו לא זמינים עדיין (למשל אין יעדי איזון, או פחות מ-2 אחזקות אמריקאיות לקורלציה) **מושמט** מהממוצע כליל, ולא מקבל ברירת-מחדל אמצעית מזויפת.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`clamp(value, min, max) = min(max, max(min, value))`** - כלי עזר בסיסי.

כל תת-מדד ממופה **לינארית** ל-0-100 (100=הכי טוב) על טווח-ייחוס עגול במכוון:

- **`concentrationScore(concentrationTop3Percent)`**: `round(clamp(100 - concentrationTop3Percent, 0, 100))` - 100 בריכוזיות 0%, 0 בריכוזיות 100% (כל התיק ב-3 פוזיציות).
- **`sectorConcentrationScore(topSectorPercent)`**: זהה, `100 - topSectorPercent`.
- **`correlationScore(avgAbsCorrelation)`**: `round(clamp(100 - avgAbsCorrelation*100, 0, 100))` - 100 בקורלציה ממוצעת 0, 0 בקורלציה מושלמת (1.0).
- **`volatilityScore(volatilityPercent)`**: `round(clamp(100 - (volatilityPercent/40)*100, 0, 100))` - טווח ייחוס: 40% תנודתיות שנתית = "בערך הגבול העליון לתיק מניות אמיתי".
- **`drawdownScore(maxDrawdownPercent)`**: `round(clamp(100 - (maxDrawdownPercent/50)*100, 0, 100))` - טווח ייחוס: 50% דרוודאון = "בערך עומק שוק-דובי אמיתי".
- **`allocationDriftScore(maxAbsDiffPercent)`**: `round(clamp(100 - (maxAbsDiffPercent/30)*100, 0, 100))` - טווח ייחוס: 30 נקודות אחוז סטייה = "כבר הרבה".

כל אחד מהם מחזיר `null` אם הקלט אינו `Number.isFinite` (כלומר "נתון לא זמין", לא "0 גרוע").

**`averageAbsCorrelation(symbols, matrix)`**

מחשבת ממוצע |קורלציה| על פני **כל** הזוגות (i<j, לא הדיאגונלה, לא ערכים `null`/`undefined`) במטריצת קורלציה (`correlationAnalysis.js`). מחזירה `null` אם אין מספיק סימבולים או אם אף זוג לא בעל ערך תקין (למשל פחות מ-20 ימים חופפים).

**`HEALTH_SCORE_SUBSCORE_LABELS_HE`** - תוויות עבריות לכל תת-מדד (מיוצא לתצוגה).

**`healthScoreLabelHe(score)`** - תרגום מספר לתווית: `null/undefined` → "אין מספיק נתונים"; `≥80` → "מצוין"; `≥60` → "טוב"; `≥40` → "בינוני"; אחרת → "טעון שיפור".

**`computePortfolioHealthScore({concentrationTop3Percent, topSectorPercent, correlationSymbols, correlationMatrix, volatilityPercent, maxDrawdownPercent, allocationMaxAbsDiffPercent} = {})`**

בונה `breakdown` עם 6 תת-מדדים (כמפורט לעיל, `correlation` מחושב מ-`averageAbsCorrelation(correlationSymbols, correlationMatrix)` שמוזן ל-`correlationScore`). לוקח את `availableScores = כל הערכים ב-breakdown שאינם null`. **`overallScore = round(Σ availableScores / availableScores.length)`**, או `null` אם אין אף תת-מדד זמין. פלט: `{overallScore, breakdown, availableCount}`.

מקרי קצה: כל המדדים במצב-הכי-טוב → 100 בכולם, ממוצע 100; כל המדדים במצב-הכי-גרוע (או מעבר לו) → 0 בכולם (לא שלילי, בגלל ה-`clamp`); רק תת-מדד אחד זמין → הממוצע הוא בדיוק הערך של אותו תת-מדד (לא מדולל ע"י אחרים); כלום זמין (`{}`) → `overallScore=null`, `availableCount=0`, לא `0` או `NaN`.

---

### `src/utils/portfolioHealthScore.test.js`

בודק: `averageAbsCorrelation` מתעלם מהדיאגונלה ומ-`null` (ממוצע |0.5| ו-|-0.3| = 0.4), מחזיר `null` כשאין אף זוג עם ערך, מתמודד עם קלט ריק/null; `healthScoreLabelHe` ממפה נכון את הגבולות (95→"מצוין", 80→"מצוין", 65→"טוב", 45→"בינוני", 10→"טעון שיפור"), ו-`null`/`undefined`→"אין מספיק נתונים"; `computePortfolioHealthScore`: מקרה-הכל-מושלם → 100 בכל 6 התת-מדדים וממוצע 100; מקרה-הכל-בגבול-הגרוע-ביותר (או מעבר לו, למשל תנודתיות 90% כשהייחוס הוא 40%) → 0 בכל התת-מדדים בלי לרדת לשלילי; רק ריכוזיות זמינה (20%→ניקוד 80) - כל השאר `null` ו-`overallScore=80` (לא ממוצע עם ערכי-מדומה) עם `availableCount=1`; כלום זמין → `overallScore=null` (לא 0/NaN), גם בקריאה בלי ארגומנטים כלל.

---

### `src/utils/benchmarkComparison.js`

#### תפקיד

משווה ביצועי תיק מול מדד שוק (S&P 500 / ת"א-125). שתי הסדרות מקבלות "בסיס 100" בתאריך המשותף הראשון שלהן, כך שהן ניתנות להשוואה ישירה ללא תלות במטבע/סקאלה מוחלטת (למשל שווי תיק כולל ב-ILS מול רמת מדד ב-USD).

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`indexSeriesToBase100(series)`**

מבסיסה סדרת `{date, value}[]` כך שהנקודה הראשונה תהיה 100 וכל נקודה מאוחרת יותר תהיה יחסית אליה: `indexed = (value/base)*100`, כאשר `base = series[0].value`. מחזירה `[]` לסדרה ריקה או `base` שקרי (0). לא בשימוש ישיר ע"י ה-UI כרגע (ל-`buildComparisonSeries` יש בנימוס עצמו), אך משמש כבלוק-בנייה עצמאי.

**`alignBenchmarkClosesToDates(dates, benchmarkPoints)`**

לכל תאריך במערך `dates` (עולה), מוצאת את שער-הסגירה העדכני ביותר **בתאריך זה או לפניו** - כלומר "מגלגלת קדימה" את שער היום-מסחר-האחרון על פני סופי-שבוע/חגים שבהם השוק סגר אבל יש תמונת-מצב תיק לאותו יום. אלגוריתם: ממיינת `benchmarkPoints` פנימית לפי תאריך, ואז עוברת פעם אחת (מצביע `i` בודד) על שני המערכים במקביל - עבור כל תאריך-מטרה, מזיזה את `i` קדימה כל עוד `sorted[i].date <= date`, שומרת `lastClose = sorted[i].close`. מחזירה `null` לתאריכים שלפני נקודת הבנצ'מרק הראשונה. קלט ריק של בנצ'מרק → כל התאריכים מקבלים `null`.

**`buildComparisonSeries(portfolioSeries, benchmarkPoints)`**

1. `dates = portfolioSeries.map(p => p.date)`
2. `alignedCloses = alignBenchmarkClosesToDates(dates, benchmarkPoints)`
3. `firstCommonIndex = alignedCloses.findIndex(c => c !== null)` - האינדקס הראשון שבו יש התאמת בנצ'מרק. אם לא נמצא (`-1`) → `[]`.
4. `portfolioBase = portfolioSeries[firstCommonIndex].value`, `benchmarkBase = alignedCloses[firstCommonIndex]` - שני הבסיסים לאינדקס-100. אם אחד מהם `0`/falsy → `[]`.
5. עבור כל נקודה **מ-`firstCommonIndex` והלאה** (חוסמת נקודות שקדמו לתחילת נתוני הבנצ'מרק): `{date, portfolioIndexed: (value/portfolioBase)*100, benchmarkIndexed: benchmarkClose !== null ? (benchmarkClose/benchmarkBase)*100 : null}`.

תוצאה: שתי סדרות המתחילות ב-100 בדיוק בתאריך המשותף הראשון - כל סטייה עתידית ביניהן היא ביצועים יחסיים אמיתיים, לא אפקט-סקאלה.

---

### `src/utils/benchmarkComparison.test.js`

בודק: `indexSeriesToBase100` - הנקודה הראשונה בדיוק 100, ו-220/200*100=110 לנקודה השנייה; קלט ריק/בסיס-0 → `[]`. `alignBenchmarkClosesToDates`: מגלגל קדימה את השער הידוע האחרון על פני פערים (סופ"ש); תאריכים לפני תחילת הבנצ'מרק → `null`; קלט בנצ'מרק ריק → הכל `null`; קלט בנצ'מרק לא-ממוין נכנס ל-`alignBenchmarkClosesToDates` בסדר וממוין פנימית. `buildComparisonSeries`: שני הסדרות מתחילות ב-100 בתאריך המשותף הראשון (10%/5% צמיחה נותנת 110/105); תיק שמכה את המדד מציג פער גדל (הפרש 15 נקודות); תאריכי תיק שקדמו לתחילת נתוני הבנצ'מרק נחתכים (`combined` באורך 2, לא 3); אין תאריכים חופפים → `[]`; סדרת תיק ריקה → `[]`.

---

### `src/utils/rebalancing.js`

#### תפקיד

מודול איזון-מחדש: המשתמש מגדיר הקצאת-מטרה (% לכל קטגוריית תיק), והמודול משווה אותה מול ההקצאה בפועל (מ-`exchangeDistribution` של `portfolioAnalysis.js`) כדי להציע כמה לקנות/למכור בכל קטגוריה כדי להגיע ליעד. מכוון בכוונה לאותן 6 הקטגוריות המוצגות ב"פיזור לפי רכיבי תיק" (ישראלי/אמריקאי/גמל/קרנות כספיות/עו"ש/חיסכון בנקאי) - **לא** מניות בודדות, כי יעד ברמת-מניה בודדת ידרוש מהמשתמש לתחזק מספר עצום יותר של יעדים, וברמת-קטגוריה זו כבר הרזולוציה הפעילה למרבית ההחלטות (למשל "לגזום חשיפה לארה"ב", לא "למכור בדיוק 3 מניות AAPL").

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`REBALANCE_CATEGORIES = ['israeli', 'american', 'pension', 'cashFunds', 'bank', 'bankSavings']`** ו-**`CATEGORY_LABELS_HE`** - תוויות עבריות (בורסה ישראלית/אמריקאית, קופות גמל, קרנות כספיות, עו"ש, קופת חיסכון בבנק).

**`emptyTargets()`** - מחזירה אובייקט עם כל הקטגוריות = 0 (ערכי התחלה לטופס).

**`sumTargetPercents(targets)`** - `Σ Number(targets[key]) || 0` על פני כל הקטגוריות (`Number('abc')` הופך ל-`NaN` → מטופל כ-0).

**`isValidTargetAllocation(targets)`** - `|sum - 100| < 0.5` - סבילות קטנה לשגיאת עיגול (למשל שלוש קטגוריות של 33.34/33.33/33.33).

**`computeRebalancingPlan(exchangeDistribution, targets)`**

עבור כל קטגוריה (`REBALANCE_CATEGORIES`):
- `currentValue`/`currentPercent` נלקחים מ-`exchangeDistribution[key]` (0 אם חסר).
- `targetPercent = Number(targets[key]) || 0`
- **`targetValue = (targetPercent/100) * totalValueILS`**
- **`diffValue = targetValue - currentValue`** - חיובי = תת-משקל (לקנות עוד כדי להגיע ליעד); שלילי = יתר-משקל (למכור/לגזום).
- **`diffPercent = targetPercent - currentPercent`**

**`maxAbsDiffPercent = max(|row.diffPercent|)`** על פני כל השורות - מספר יחיד גס המציג "כמה התיק כולו סוטה מהיעד", המבוסס על הקטגוריה עם הסטייה הגדולה ביותר (כך שסטייה של 3% במקום כלשהו לא מוצגת בדחיפות זהה לסטייה של 25%). מדד זה מוזן גם ל-`portfolioHealthScore.js`'s `allocationDriftScore`.

פלט: `{ totalValueILS, rows (6 אובייקטים), isValidAllocation, maxAbsDiffPercent }`.

מקרי קצה: `exchangeDistribution` חסר לחלוטין → `totalValueILS=0`, 6 שורות עם ערכי 0, לא נזרקת שגיאה.

---

### `src/utils/rebalancing.test.js`

בודק: `emptyTargets` מחזירה 6 קטגוריות ב-0; `sumTargetPercents`/`isValidTargetAllocation` מסכמים נכון, דוחים סכום שאינו ~100, סובלים שגיאת עיגול קטנה (33.34+33.33+33.33), ומתייחסים לערכים חסרים/לא-מספריים כ-0; `computeRebalancingPlan`: תיק שכבר בדיוק ביעד → כל ה-diffs אפס; קטגוריית יתר-משקל מקבלת `diffValue` שלילי (מכירה) וקטגוריית תת-משקל חיובי (קנייה) - עם ערכים מדויקים (ישראלי 40%→20% על 10,000 סה"כ = diff -2000); `maxAbsDiffPercent` בוחר את הסטייה הגדולה ביותר מבין כל הקטגוריות; תיק ריק/`exchangeDistribution` חסר לא זורק שגיאה ומחזיר 6 שורות אפסיות.

---

### `src/utils/correlationAnalysis.js`

#### תפקיד

מחשב קורלציה בין תשואות יומיות היסטוריות של אחזקות - "כשמניה A זזה, האם מניה B נוטה לזוז איתה?". תיק יכול להיראות מגוון לפי סקטור/בורסה ועדיין להחזיק בטופ שלו מניות שזזות כמעט בלוקסטפ, מה שאף אחת מהפילוחים האחרים לא יכולה להראות. מוגבל למניות אמריקאיות בלבד: הבורסה הישראלית (TASE) אינה בעלת מקור-נתונים היסטורי חינמי/ללא-תלות כמו ה-endpoint של Yahoo.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`MIN_OVERLAPPING_RETURNS = 20`** - מתחת לכמות זו של ימי-מסחר חופפים, מקדם קורלציה הוא "רעש יותר מסיגנל" - מסומן `null` במקום מספר שנראה מדויק אך מטעה.

**`computeDailyReturns(points)`**

ממירה `{date, close}[]` (עולה לפי תאריך) ל-`{date, return}[]` של שינוי יומי אחוזי: `return = close/prevClose - 1`. מדלגת על נקודה עם `close`/`prevClose` חסר/לא-סופי. פחות מ-2 נקודות → `[]`.

**`pearsonCorrelation(returnsA, returnsB)`**

מקדם קורלציה של פירסון, בין שתי סדרות תשואה, **מותאם לפי תאריך** (inner join, לא לפי אינדקס) - מתמודד עם סימבולים בעלי לוח-מסחר שונה במקצת (תאריכי-רישום שונים, חגי-בורסה שונים) בלי לדרוש שכל סימבול יחלוק כל תאריך.

אלגוריתם:
1. `byDateB = Map(returnsB by date)`
2. `pairs = [[a.return, byDateB.get(a.date)] for a in returnsA if byDateB.has(a.date)]`
3. אם `pairs.length < MIN_OVERLAPPING_RETURNS` → `null`
4. `n = pairs.length`; `meanA`, `meanB` = ממוצעים
5. עבור כל זוג: `da = a - meanA`, `db = b - meanB`; `cov += da*db`; `varA += da²`; `varB += db²`
6. אם `varA === 0 || varB === 0` (סדרה שטוחה) → `null`
7. **`correlation = cov / sqrt(varA * varB)`** (נוסחת פירסון הסטנדרטית: קוו-וריאנס מנורמל ע"י מכפלת סטיות-התקן)

**`buildCorrelationMatrix(historyBySymbol)`**

`historyBySymbol: {SYMBOL: {date, close}[]}`. מסננת סימבולים עם פחות מ-2 נקודות מחיר, ומיינת אלפביתית (`symbols`) - סדר עמודות/שורות יציב בטבלה. מחשבת `returnsBySymbol` לכל סימבול, ואז בונה `matrix[i][j]` - `1` על הדיאגונלה, אחרת `pearsonCorrelation(returns[i], returns[j])`. מחזירה `{symbols, matrix}`. קלט ריק → `{symbols: [], matrix: []}`.

**`highestCorrelatedPairs(symbols, matrix, limit = 3)`**

בונה רשימת כל הזוגות (i<j) בעלי ערך לא-`null`/`undefined`, ממיינת יורד לפי `|correlation|`, מגבילה ל-`limit`. משמש לתת "אלו שני סימבולים הכי-קשורים" כדוח מהיר במקום להציג את כל המטריצה. קלט חסר → `[]`.

---

### `src/utils/correlationAnalysis.test.js`

בודק: `computeDailyReturns` מחשב שינוי יומי (0.1, -0.1) ומדלג על הנקודה הראשונה; מדלג נקודה עם `close` פגום; קלט קטן/ריק/null לא זורק. `pearsonCorrelation`: 1 לסדרות זהות; -1 לסדרות מנוגדות; `null` כשפחות מ-20 תאריכים חופפים; מתאים לפי תאריך בלבד (תאריכים שקיימים בסדרה אחת בלבד מוחרגים); `null` לסדרה שטוחה (שונות-0). `buildCorrelationMatrix`: מטריצה סימטרית עם 1 בדיאגונלה, סימבולים ממוינים אלפביתית, קורלציה 1 לסדרות זהות ו-1- להפכיות, מוציאה סימבולים עם פחות מ-2 נקודות מחיר; קלט ריק → `{[], []}`. `highestCorrelatedPairs`: מדרג לפי |קורלציה| יורד ומחריג דיאגונלה/null; מכבד את הגבול (limit); קלט חסר לא זורק.

---

### `src/utils/sectorAnalysis.js`

#### תפקיד

מגוון-השקעה לפי סקטור - שאלה שונה מ-`exchangeDistribution` (`portfolioAnalysis.js`), שעונה רק "כמה בישראלי מול אמריקאי". מישהו יכול להחזיק 10 טיקרים אמריקאים שונים ובכל זאת להיות מרוכז מאוד בסקטור אחד; זה נראה רק כשמקבצים לפי סקטור במקום לפי בורסה. מוגבל למניות אמריקאיות בלבד: מידע הסקטור מגיע מ-Yahoo Finance לפי טיקר, ואחזקות ישראליות (TASE) מזוהות במספר-ני"ע ישראלי, לא טיקר תואם-Yahoo, כך שאין מיפוי סקטור זמין להן בלי מקור-נתונים נפרד - מגבלה מוצהרת ולא תקלה.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`computeSectorDistribution(americanStocks, sectorBySymbol)`**

`sectorBySymbol: {[symbol]: {sector, industry}}`. לכל מניה אמריקאית: `value = calculateAmericanStockMetrics(stock).totalCurrentValueILS`; `symbol = String(stockName).trim().toUpperCase()`; `sectorKey = sectorBySymbol[symbol]?.sector || UNCLASSIFIED_SECTOR_KEY`. מצטבר לתוך `totalsBySector[sectorKey] = {value, symbols: Set}`.

לאחר איסוף: `sectors = [{sectorKey, value, percentage: value/totalValueILS*100, symbolCount: symbols.size}]`, ממוין יורד לפי `value`. `topSectorPercent = sectors[0].percentage` (0 אם אין סקטורים). `hasData = sectors.length > 0`.

פלט: `{totalValueILS, sectors, hasData, topSectorPercent}` - `topSectorPercent` מוזן ישירות ל-`portfolioHealthScore.js`'s `sectorConcentrationScore`.

מקרי קצה: תיק ריק → `hasData=false`, `sectors=[]`, `topSectorPercent=0`; `sectorBySymbol` חסר/undefined → כל המניות מקובצות תחת `UNCLASSIFIED_SECTOR_KEY` בלי שגיאה.

---

### `src/utils/sectorAnalysis.test.js`

בודק: קיבוץ נכון לפי סקטור עם אחוזים מדויקים (שתי מניות באותו סקטור = 2/3 מהתיק, השלישית 1/3); מיון יורד לפי שווי (הגדולה ביותר ראשונה, `topSectorPercent` תואם); מניות בלי סקטור מוכר מקובצות תחת `UNCLASSIFIED_SECTOR_KEY`; תיק ריק → `hasData=false`; `sectorBySymbol` חסר לא זורק שגיאה.

---

### `src/utils/stockGrouping.js`

#### תפקיד

פונקציות עזר לקיבוץ מניות לתצוגת הטבלאות (השורות הניתנות-להרחבה/כיווץ). חולץ מ-`App.js` - התנהגות זהה, רק המיקום השתנה. שימושי גם בטבלאות UI (לא רק בניתוח) לקיבוץ lots תחת שם מניה אחד.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`groupStocksByName(stocks)`**

מקבצת מערך מניות למפה `{[stockName]: stock[]}` - כל lot נכנס למערך לפי שם המניה שלו. סדר המפתחות נשמר לפי סדר ההופעה הראשון של כל שם (לא ממוין). מערך ריק → `{}`.

**`calculateGroupSummary(stocks)`**

מקבלת קבוצת lots של אותה מניה, ומחזירה סיכום:
- `totalQuantity = Σ quantity`
- `totalPurchaseValue = Σ (purchasePrice * quantity)`
- `totalCurrentValue = Σ (normalizeIsraeliPrice(currentPrice) * quantity)`
- `totalProfit = totalCurrentValue - totalPurchaseValue`
- `profitPercentage = calculateProfitPercentage(totalPurchaseValue, totalCurrentValue)` (מ-`formatters.js`: `((current-purchase)/purchase*100).toFixed(2)`, או `0` אם `purchaseValue` הוא 0/falsy)
- **`averagePurchasePrice = totalPurchaseValue / totalQuantity`** (ממוצע-משוקלל-כמות, לא ממוצע פשוט של המחירים)
- **`averageCurrentPrice = totalCurrentValue / totalQuantity`** (זהה)

שני הממוצעים מוגנים מחלוקה-באפס (`totalQuantity > 0 ? ... : 0`).

---

### `src/utils/stockGrouping.test.js`

בודק: `groupStocksByName` מקבצת נכון (TEVA פעמיים, ICL פעם אחת) ומחזירה `{}` לקלט ריק; `calculateGroupSummary` מסכם כמות/שווי-רכישה/שווי-נוכחי על פני lots מרובים בערכים מדויקים, מוודא ש-`averagePurchasePrice`/`averageCurrentPrice` הם ממוצעים משוקללים (לא פשוטים), ומתפקד זהה עבור קבוצה של lot בודד.

---

### `src/utils/valuationSpectrum.js`

#### תפקיד

מתמטיקת מיקום (layout) לפס ה"מחיר מול שווי הוגן" בסגנון SimplyWall.st (`StockResearchView.js`) - מופרד מהקומפוננטה כך שהמיקום ניתן לבדיקה ישירה, בהתאם למוסכמת האפליקציה של הוצאת לוגיקת חישוב מ-JSX. הציר הוא "% סטייה של המחיר מהשווי ההוגן" - השווי ההוגן קבוע במרכז (0%, בהגדרה), ומחיר השוק הנוכחי ממוקם לפי הסטייה האמיתית שלו. אזורי צבע (ירוק/כתום/אדום) ממוקמים בגבולות ±20% (מוסכמה של SimplyWall.st עצמה: "20% Undervalued"/"About Right"/"20% Overvalued"), והטווח הנראה מתרחב כדי להכיל חריג קיצוני במקום לקטוע אותו בקצה הפס.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**קבועים:** `ZONE_BOUNDARY_PERCENT = 20`; `MIN_RANGE_PERCENT = 60`; `MIN_LABEL_GAP_PERCENT = 14`.

**`computeValuationSpectrumLayout(fairValuePerShare, currentPrice)`**

תיקוף קלט: `fairValuePerShare` חייב להיות מספר סופי חיובי (`> 0`); `currentPrice` חייב להיות מספר סופי `>= 0` (0 עצמו תקין, לא נחשב "חסר"). אחרת → `null`.

1. **`overvaluedPercent = (currentPrice - fairValue) / fairValue * 100`** - הסטייה האחוזית של המחיר מהשווי ההוגן (חיובי = יקר-מדי, שלילי = זול-מדי).
2. **`range = max(60, |overvaluedPercent| * 1.15)`** - הטווח הנראה על הפס: לפחות ±60%, או קצת יותר (מרווח נשימה של 15%) כדי שנקודת-הקצה תיכנס לפס בלי להיצמד לגמרי לשוליים.
3. **`toPosition(deviationPercent) = 50 + (clamp(deviationPercent, -range, range) / range) * 50`** - ממפה סטייה אחוזית למיקום 0-100 על הפס (50 = מרכז).
4. `underZoneBoundaryPosition = toPosition(-20)`; `overZoneBoundaryPosition = toPosition(+20)` - מיקומי גבולות האזור בפועל (מדויקים מתמטית, יכולים להיות קרובים למרכז כשה-range גדול).
5. **`underZoneLabelPosition = min(underZoneBoundaryPosition, 50 - 14)`**; **`overZoneLabelPosition = max(overZoneBoundaryPosition, 50 + 14)`** - מיקום ה**תווית הטקסטואלית** בלבד (לא אזור הצבע עצמו): נדחף לפחות 14 יחידות מהמרכז, כדי שהתוויות לא יתקבצו/יחפפו כשה-range גדול מאוד וגבולות ±20% האמיתיים מתקרבים מדי למרכז.

פלט: `{overvaluedPercent, isOvervalued (>=0), range, currentPricePosition: toPosition(overvaluedPercent), fairValuePosition: 50, underZoneBoundaryPosition, overZoneBoundaryPosition, underZoneLabelPosition, overZoneLabelPosition}`.

מקרי קצה: שווי הוגן `<=0`/חסר → `null`; מחיר נוכחי שלילי/חסר → `null`; מחיר נוכחי `=0` בדיוק תקין (`overvaluedPercent=-100`); סטייה קיצונית (למשל 3067% יקר) → הטווח מתרחב בהתאם, אך `currentPricePosition` נשאר תמיד קטן-אמת מ-100 (לא נצמד לקצה); סטייה קלה (1%) → הטווח לא מתכווץ מתחת ל-60.

---

### `src/utils/valuationSpectrum.test.js`

בודק: השווי ההוגן תמיד במרכז (50); מקרה-ייחוס תואם SimplyWall.st (שווי הוגן 569.6$, מחיר 956.08$ → ~67.9% יקר-מדי, ממוקם מימין למרכז); מניה זולה ממוקמת משמאל למרכז; מחיר=שווי-הוגן בדיוק → אותו מיקום (50); סטייה קיצונית (30$ מול 950$, ~3067%) מרחיבה את הטווח מעבר ל-2500 אך שומרת את המיקום קטן-מ-100; הטווח לא-קטן-מ-60 אף במקרה סטייה קטנה מאוד (1%); גבולות האזור בתוך התחום 0-100; קלט לא-חיובי/חסר לשווי-הוגן → `null`; מחיר שלילי/חסר → `null`; מחיר=0 תקין (לא נחשב חסר, נותן -100%); **מיקומי תווית**: לסטייה קלה (טווח רחב) התווית תואמת בדיוק את הגבול האמיתי; לסטייה קיצונית (~3110% - מקרה תצפית אמיתי) התוויות נדחפות למרווח מינימלי (14) גם כשהגבול האמיתי קרוב-כמעט-למרכז (<2 יחידות ממנו); התוויות לעולם לא נדחפות **פנימה** מעבר לגבול האמיתי, רק החוצה.

---

### `src/utils/stockScorecard.js`

#### תפקיד

מייצר "כרטיס ניקוד" בסגנון SimplyWall.st ממידע פונדמנטלי גולמי (`server/stockResearchRoutes.js`, בתוספת נתוני דיבידנד קיימים מ-`dividendRoutes.js`): בדיקות (checks) בעלות שם, מקובצות לקטגוריות, כל אחת עבור/נכשל/`null` (`null` = אין מספיק מידע - לעולם לא מזויף כערך-אמצע, אותו עקרון כמו ב-`portfolioHealthScore.js`), בתוספת נוסחת פסק-דין BUY/HOLD/SELL שקופה. SimplyWall.st עצמה **לא** מפרסמת נוסחת קנייה/מכירה (רק ניקוד בדיקות-שעברו) - הפסק-דין למטה הוא כלל של האפליקציה הזו, מתועד כאן, לא קופסה שחורה. **זו היוריסטיקה על נתונים ציבוריים, לא ייעוץ השקעות.**

הערה חשובה על "ביצועים היסטוריים": משתמש ב-`fundamentalsHistory` - endpoint שונה של Yahoo (`fetchYahooFundamentalsTimeseries`) המחזיר בפועל נתוני-שורה מרובי-שנים (מאומת בפיתוח), בשונה מ-`quoteSummary`'s legacy modules (`balanceSheetHistory`, `incomeStatementHistory`) שהתגלו כמחזירים "קונכיות" ריקות (תאריכים בלבד, בלי פריטי-שורה בפועל). היחסים הפיננסיים השוטפים (מ-`financialData`) עדיין מניעים את "בריאות פיננסית" - שני מקורות הנתונים מכסים דברים שונים (תמונת-מצב נגד מגמה).

בנוסף, בדיקות "שווי הוגן" של SimplyWall.st משוות P/E, P/B וכו' מול ממוצעי-שוק/תעשייה - מסד-נתונים של אלפי מניות שלאפליקציה הזו אין. הבדיקות למטה משתמשות בספי-ייחוס קבועים ומתועדים במקום זאת - פשטנות מכוונת, לא ניסיון לשכפל את המספרים המדויקים שלהם.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`summarizeChecks(checks)`** (פרטית) - `applicable = checks.filter(passed !== null)`; `passed = applicable.filter(passed===true).length`; מחזירה `{checks, passed, total: applicable.length}`. **בדיקות עם `passed=null` מוחרגות לחלוטין מהמכנה** - לא נספרות כנכשלות.

**`categoryPercent(category)`** - `category.total > 0 ? passed/total*100 : null`.

**קטגוריית Value (`computeValueChecks`)** - `VALUE_PE_MAX=25`, `VALUE_PB_MAX=3`. 3 בדיקות:
- `peReasonable`: `pe > 0 && pe <= 25` (P/E שלילי - חברה מפסידה - **נכשל**, לא "עובר" בגלל מספר קטן).
- `pegAttractive`: `peg > 0 && peg <= 1` (יחס PEG בטווח 0-1 - צמיחה מתומחרת בזול).
- `pbReasonable`: `pb > 0 && pb <= 3`.

**קטגוריית Future Growth (`computeFutureGrowthChecks`)** - 4 בדיקות:
- `earningsGrowthPositive`: `earningsGrowth > 0`.
- `revenueGrowthPositive`: `revenueGrowth > 0`.
- `highGrowth`: `earningsGrowth > 0.1` (מעל 10%).
- `analystUpside`: `computeUpsidePercent(currentPrice, targetMeanPrice) > 0`, כאשר `computeUpsidePercent = (target-current)/current*100` (מ-`analystData.js`) - `null` אם אחד המחירים חסר.

**קטגוריית Financial Health (`computeFinancialHealthChecks`)** - `HEALTH_CURRENT_RATIO_MIN=1`, `HEALTH_DEBT_TO_EQUITY_MAX=100` (Yahoo מחזיר בסקאלת 0-100+% ולא שבר 0-1). 4 בדיקות:
- `currentRatio`: `currentRatio > 1`.
- `debtToEquity`: `debtToEquity < 100`.
- `cashflowCoverage`: `(operatingCashflow/totalDebt)*100 > 20` - **מחושב `null` אם `totalDebt` לא סופי/לא-חיובי** (הגנה מחלוקה-באפס, לא `Infinity`).
- `returnOnEquity`: `roe > 0.15`.

**קטגוריית Past Performance (`computePastPerformanceChecks`)** - משתמשת ב-`fundamentalsHistory`. פונקציית עזר `buildRatioSeries(numerator, denominator)`: מצטרפת (inner join) שתי סדרות `{date, value}[]` לפי תאריך משותף, ומחשבת `numerator.value/denominator.value` - **מדלגת נקודות שבהן `denominator.value === 0`** (מונע `Infinity`). `growthCheck(series, formatAsPercent)`: משווה נקודה ראשונה מול אחרונה בסדרה, `passed = last.value > first.value`; `null` אם פחות מ-2 נקודות.

4 בדיקות:
- `epsGrowth`: `growthCheck(annualDilutedEPS)`.
- **`epsAcceleration`**: דורשת 3+ נקודות EPS. מחשבת סדרת צמיחה שנה-על-שנה `yoyGrowths[i] = (eps[i]-eps[i-1]) / |eps[i-1]|` (מדלגת מכנה=0), ואז `passed = latest > average(yoyGrowths)` - כלומר בודקת אם קצב הצמיחה **מתאיץ** (השנה האחרונה מהירה מהממוצע ההיסטורי), לא רק אם EPS גדל בסה"כ. דורשת 2+ ערכי YoY (=3+ נקודות EPS).
- `roceImprovement`: `growthCheck(buildRatioSeries(annualEBIT, annualInvestedCapital), true)` - ROCE = EBIT/הון מושקע.
- `roaImprovement`: `growthCheck(buildRatioSeries(annualNetIncome, annualTotalAssets), true)` - ROA = רווח נקי/סך נכסים.

**קטגוריית Ownership (`computeOwnershipChecks`)** - 3 בדיקות:
- `insiderOwnership`: `heldPercentInsiders > 0.05` (5%).
- `institutionalOwnership`: `heldPercentInstitutions > 0.3` (30%).
- `insiderNetBuying`: `purchases >= sales`, **אבל רק אם `sales+purchases > 0`** (אחרת `null` - "אין סיגנל" ולא "עבר").

**קטגוריית Dividend (`computeDividendChecks`)** - 2 בדיקות:
- `paysDividend`: `dividendYieldPercent > 0`.
- `payoutSustainable`: `payoutRatio > 0 && payoutRatio < 0.9` (בטווח 0-90%) - **מחושב רק אם `paysDividend` תקין**, כלומר אם התשואה 0 - הבדיקה הזו כלל לא מחושבת/רלוונטית (`passed=null` אם `payoutRatio` חסר; הבדיקות עצמאיות בפועל אך במקרה-בוחן ריבית=0 השדה `payoutRatio` בד"כ גם חסר).

**`computeStockVerdict(categories)`** - כלל הפסיקה של האפליקציה (**לא** של SimplyWall.st):
1. `included = categories שיש להן total > 0` (מוציא קטגוריות בלי מידע כלל). אם אין אף קטגוריה כזו → `{verdict: null, overallPercent: null, totalPassed: 0, totalChecks: 0}` (**`null`, לא HOLD כברירת-מחדל** - "אין לנו מידע" ≠ "בדקנו וזה בינוני").
2. `totalPassed = Σ passed`, `totalChecks = Σ total` (על פני הקטגוריות שנכללו); `overallPercent = totalPassed/totalChecks*100`.
3. `valuePercent = categoryPercent(categories.value)`; `healthPercent = categoryPercent(categories.financialHealth)`.
4. **`verdict = 'HOLD'`** כברירת מחדל, ואז:
   - **אם `healthPercent <= 33`** → `SELL` (בעיית סולבנסי גוברת על הכל).
   - **אחרת אם `overallPercent <= 35`** → `SELL`.
   - **אחרת אם `overallPercent >= 65 && valuePercent >= 50`** → `BUY` (חברה מצוינת אך במחיר גרוע = HOLD, לא BUY - חובה שגם ה-Value יעבור מחצית מהבדיקות).
   - כל השאר → `HOLD`.

**`CATEGORY_LABELS_HE`**, **`VERDICT_LABELS_HE`** - תוויות עבריות.

**`buildStockScorecard(research, dividendData)`** - הפונקציה המאחדת: מפעילה את כל שש הקטגוריות (`value, futureGrowth, pastPerformance, financialHealth, dividend, ownership`) ואת `computeStockVerdict` עליהן. מחזירה `{categories, verdict}`.

---

### `src/utils/stockScorecard.test.js`

בודק את כל שש קטגוריות הבדיקה בנפרד, בתוספת שכבת הפסיקה:
- **Value**: מקרה "טוב" עובר את כל 3; PE/PEG/PB גבוהים מדי נכשלים; **PE שלילי (חברה מפסידה) נכשל, לא "עובר בגלל מספר קטן"**; שדות חסרים → הכל `null`, מוחרגים מ-total.
- **Future Growth**: מקרה "טוב" עובר את כל 4; צמיחה שלילית נכשלת; חוסר נתוני-מטרת-אנליסטים → `null`, לא כישלון.
- **Past Performance**: EPS/ROCE/ROA עולים עוברים את כל 4 (כולל האצה אחרי ירידה חד-שנתית); חברה בדעיכה נכשלת ב-EPS/ROCE/ROA; **דעיכה בקצב-הצמיחה** (5% אחרון מול ממוצע ~29%) נכשלת ב-`epsAcceleration` אך עדיין עוברת `epsGrowth` (סיגנלים נפרדים); התאמת-תאריכים ל-ROCE/ROA מדלגת נקודות לא-תואמות; מכנה=0 מוחרג (לא Infinity), ואם נשארת רק נקודה אחת → `null`, לא כישלון; קלט ריק/חסר → הכל `null`; EPS דורש 2 נקודות לצמיחה רגילה אך 3 להאצה.
- **Financial Health**: מקרה בריא עובר את כל 4; מקרה חלש נכשל בכולם; `totalDebt=0` → `cashflowCoverage=null`, לא `Infinity`.
- **Ownership**: מקרה טוב עובר את כל 3; מכירות>קניות → נכשל; 0 מכירות ו-0 קניות → `null` (אין סיגנל).
- **Dividend**: מקרה תקין עובר את שתיהן; תשואה-0 נכשלת ב"משלמת דיבידנד" בלי לפגוע ב-`payoutSustainable` (`null`); יחס-חלוקה מעל 90% נכשל; חסר לחלוטין → `total=0`.
- **`categoryPercent`**: מחשב אחוז, `null` לקטגוריה בלי בדיקות רלוונטיות.
- **`computeStockVerdict`**: BUY כשעולם ≥65% וגם Value ≥50%; HOLD (לא BUY) כש-Value חלש למרות עולם גבוה (מוודא שזה שומר-Value ולא ניקוד-כולל שחוסם); SELL כש-עולם ≤35%; SELL כש-Financial Health בלבד ≤33% גם אם העולם נראה תקין (מוודא שזו עקיפת-Health ולא שיעור-עולם); HOLD למקרה-בינוני; `null` (לא HOLD) כשאין מידע שמיש בכלל; לא זורק על קטגוריות חסרות.
- **`buildStockScorecard`**: משלב את כל הקטגוריות + פסק-דין למניה תקינה מלאה (BUY); ומטפל בסימבול בלי מידע נטען כלל (הכל `null`/`total=0`) בלי לזרוק שגיאה.

---

### `src/utils/sectorLabels.js`

#### תפקיד

מודול תרגום קטן: Yahoo Finance מחזירה שמות סקטור בסגנון GICS באנגלית (ממודול `assetProfile`). האפליקציה כולה בעברית, אז המודול הזה מתרגם את השמות הנפוצים לתצוגה; כל שם שאינו במפה נופל חזרה לשם האנגלי המקורי (**לא נעלם**), כי מחרוזות סקטור חדשות/פחות-נפוצות אכן מופיעות מדי פעם.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`SECTOR_LABELS_HE`** - מפת תרגום קבועה בת 11 ערכים (Technology→טכנולוגיה, Financial Services→שירותים פיננסיים, Healthcare→בריאות, Consumer Cyclical→צריכה מחזורית, Consumer Defensive→צריכה בסיסית, Industrials→תעשייה, Energy→אנרגיה, Utilities→תשתיות, Real Estate→נדל"ן, Communication Services→תקשורת, Basic Materials→חומרי גלם).

**`UNCLASSIFIED_SECTOR_KEY = '__unclassified__'`** ו-**`UNCLASSIFIED_SECTOR_LABEL_HE = 'לא סווג'`** - קבועים המשמשים גם ב-`sectorAnalysis.js` לזיהוי מניות בלי מידע סקטור.

**`sectorLabelHe(sectorKey)`** - אם `sectorKey` חסר או שווה ל-`UNCLASSIFIED_SECTOR_KEY` → "לא סווג"; אחרת מחזירה `SECTOR_LABELS_HE[sectorKey]`, ואם לא קיים במפה - את `sectorKey` המקורי (באנגלית) ללא שינוי.

אין קובץ בדיקות (`sectorLabels.test.js`) עבור מודול זה ברשימת הקבצים שסופקה.

## חלק 4: מנועי פיננסים/מס (utils)

# תיעוד טכני מפורט — מנועי מס/פיננסים/עיצוב-דאטה ב-`src/utils/` (afikinvest)

---

### `src/utils/cpiTax.js`

#### תפקיד

הקובץ הזה הוא ליבת מנוע חישוב **מס רווח הון "ריאלי"** של האפליקציה — כל חישוב מס שמבוסס על הצמדה למדד המחירים לצרכן (CPI) עובר דרך הפונקציות כאן. הרעיון המרכזי: כאשר נכס (מניה ישראלית, הפקדה לקופת גמל, או קופת חיסכון בבנק במסלול צמוד) צמוד למדד, לא כל הרווח הנומינלי (שווי נוכחי פחות עלות מקורית) הוא רווח "אמיתי" — חלק ממנו הוא רק פיצוי על אינפלציה. לפי הדין הישראלי (ובעיקר לפי הלכת מוזס), מס רווח הון (25%) חל רק על ה"רווח הריאלי" — הרווח שנשאר אחרי ניכוי הרכיב האינפלציוני. הקובץ מיישם את הכלל **האסימטרי** שנקבע בפסיקה (ולא נוסחה סימטרית נאיבית), עם דגש מפורש בקוד שזו אינה ייעוץ מס פורמלי.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**קבועים:**
- `STOCK_REAL_GAIN_TAX_RATE = 0.25` — מס רווח הון על מניות (ריאלי).
- `PENSION_LINKED_REAL_GAIN_TAX_RATE = 0.25` — מס על קופות גמל (ריאלי, תמיד).
- `BANK_SAVINGS_NOMINAL_TAX_RATE = 0.15` — מס שטוח על קופת חיסכון בבנק לא-צמודה (נומינלי).
- `BANK_SAVINGS_REAL_TAX_RATE = 0.25` — מס על קופת חיסכון צמודה למדד (ריאלי).

**`monthKeyFromDate(dateStr)`** — ממיר תאריך (`"2024-03-15"`) למפתח חודש (`"2024-03"`) ע"י `slice(0,7)`. הרציונל: מדד המחירים לצרכן מתפרסם ברזולוציה חודשית בלבד, כך שההצמדה תמיד מבוססת על "מדד החודש" ולא על יום מדויק. מחזיר `null` אם אין תאריך.

**`indexedCostBasis(originalCost, indexAtCost, currentIndex)`** — הנוסחה הבסיסית של הצמדה למדד:
```
עלות מותאמת = עלות מקורית × (מדד עדכני / מדד בסיס)
```
אם `indexAtCost` חסר/0/שלילי או `currentIndex` חסר — מחזיר את `originalCost` כפי שהוא (ללא הצמדה), כמנגנון fail-safe: מוטב לחשב מס גבוה במקצת מאשר לקרוס.

**`calculateLinkedRealResult({ originalCost, currentValue, adjustedCostBasis, taxRate = 0.25 })`** — הפונקציה המרכזית ביותר בקובץ. מיישמת את **הכלל האסימטרי מהלכת מוזס** (ע"א 3555/15, 3723/15, 5447/16). מגדירה:
```
nominalGain = currentValue - originalCost
linkageComponent = adjustedCostBasis - originalCost   (חיובי אם ההצמדה מעלה את העלות, שלילי אם מורידה)
```
ומפעילה 4 מקרים (מטריצה של סימן `linkageComponent` × סימן `nominalGain`):

1. **הצמדה כלפי מעלה (linkageComponent ≥ 0) + רווח נומינלי (nominalGain ≥ 0):**
   ```
   exemptAmount = min(linkageComponent, nominalGain)
   realGain = nominalGain - exemptAmount
   ```
   כלומר הסכום הפטור ("סכום אינפלציוני") מוגבל ל-min בין רכיב ההצמדה לרווח הנומינלי עצמו — הרווח הריאלי לעולם לא יורד מתחת ל-0 אפילו אם ההצמדה התיאורטית עולה על הרווח (לדוגמה 2 בפסק הדין: מכירה 50$@11=550, רכישה 100$@5=500 → nominalGain=50, linkageComponent=600 (500×11/5-500), אבל exemptAmount מוגבל ל-50, ו-realGain=0, לא שלילי).

2. **הצמדה כלפי מעלה + הפסד נומינלי (nominalGain < 0):**
   ```
   realGain = nominalGain   (אין exemptAmount, אין הגדלת הפסד)
   ```
   ההפסד מוכר במלואו כפי שהוא — לא "מוגדל" לפי ההצמדה גם אם הנישום היה מעדיף כך (נדחה בפסק הדין).

3. **הצמדה כלפי מטה (linkageComponent < 0) + רווח נומינלי:**
   ```
   realGain = nominalGain   (חייב במלואו, ללא הקלה)
   ```
   ירידת מדד/שער אינה "מקטינה" רווח חייב במס.

4. **הצמדה כלפי מטה + הפסד נומינלי:**
   ```
   realGain = currentValue - adjustedCostBasis   (הפסד בר-קיזוז, בגודל מוחלט קטן יותר מההפסד הנומינלי)
   nonDeductibleAmount = nominalGain - realGain   (שלילי — גודל החלק שאינו בר-קיזוז)
   ```

לבסוף: `tax = realGain > 0 ? realGain * taxRate : 0` — המס מוטל תמיד על התוצאה הריאלית הסופית, לעולם לא על הרווח הנומינלי. מחזירה `{ nominalGain, realGain, exemptAmount, nonDeductibleAmount, tax }`.

**`calculateStockRealGainTax({ purchasePrice, quantity, currentValue, indexAtPurchase, currentIndex, taxRate })`** — עוטפת את שתי הפונקציות הקודמות למקרה הפרטני של lot מניה בודד: מחשבת `originalCost = purchasePrice × quantity`, מצמידה אותו ל`adjustedCost` דרך `indexedCostBasis`, ומריצה `calculateLinkedRealResult`. מחזירה `{ originalCost, adjustedCost, realGain, tax }`.

**`calculatePensionRealGainTax({ deposits, currentValue, currentIndex, indexByMonth, taxRate })`** — מודל "פנקס הפקדות" מלא לקופת גמל: כל הפקדה (`{date, amount}`) מוצמדת בנפרד למדד לפי חודש ההפקדה שלה (`indexByMonth[monthKeyFromDate(d.date)]`), העלויות המותאמות מסוכמות, ואז מופעל הכלל האסימטרי על **סך** ההפקדות מול **סך** העלות המותאמת (ולא per-deposit). קופות גמל **תמיד** ממוסות על הרווח הריאלי ב-25%, ללא ברירת מס נומינלי — אין עוד "מסלול לא-צמוד" בקופת גמל (בשונה מקופת חיסכון בבנק). אם אין מדד לחודש הפקדה מסוים — אותה הפקדה בודדת לא מוצמדת (fallback). מחזירה `{ totalDeposited, adjustedCostBasis, gain, tax, mode: 'real' }`.

**`calculateBankSavingsFundTax({ deposits, currentValue, isLinkedToIndex, currentIndex, indexByMonth })`** — לקופת חיסכון בבנק **יש** משמעות אמיתית לבחירת מסלול הצמדה (זו בחירה אמיתית של המשתמש, לא רק שאלת מיסוי):
- **לא צמוד** (או `currentIndex` חסר — fail-safe): `gain = currentValue - totalDeposited`; `tax = gain > 0 ? gain * 0.15 : 0`. מחזירה `{ totalDeposited, gain, tax, mode: 'nominal' }`.
- **צמוד למדד**: כמו קופת גמל — כל הפקדה מוצמדת לפי חודשה, `calculateLinkedRealResult` על הסכומים, ומס 25% על התוצאה. מחזירה `{ totalDeposited, adjustedCostBasis, gain: realGain, tax, mode: 'real' }`.

---

### `src/utils/cpiTax.test.js`

בודק את כל שרשרת הפונקציות ב-`cpiTax.js`, כולל **5 הדוגמאות המדויקות מהלכת מוזס** (ground truth ישירות מפסק הדין, לא הנחה של המפתחים):
1. רווח + הצמדה כלפי מעלה → realGain=350, exempt=200 (מכירה 150$@7=1050, רכישה 100$@5=500).
2. רווח קטן + הצמדה קיצונית → הרווח הריאלי "מתאפס" (0), לא הופך לשלילי; exempt מוגבל ל-50 (הרווח הנומינלי), לא ל-600 התיאורטי.
3. הפסד + הצמדה כלפי מעלה → ההפסד מוכר במלואו (-150), לא מוגדל.
4. רווח + הצמדה כלפי מטה → כל הרווח הנומינלי (100) חייב, ללא הקלה.
5. הפסד + הצמדה כלפי מטה → רק חלק מההפסד בר-קיזוז (-150 מתוך -350), `nonDeductibleAmount = -200`.

בנוסף: `indexedCostBasis` — בדיקת 10% אינפלציה (1000→1100) ו-fallback כשאין מדד בסיס; `calculateStockRealGainTax` — מקרה שבו הרווח הנומינלי כולו אינפלציוני (מס=0), מקרה עם מס בפועל (200×0.25), ומקרה cap; `calculatePensionRealGainTax` — הצמדה נפרדת לכל הפקדה, fallback להפקדה בודדת בלי מדד, taxRate מותאם אישית; `calculateBankSavingsFundTax` — נומינלי 15%, ריאלי 25%, fallback ל-nominal כשאין CPI, והפקדות מרובות עם הצמדה נפרדת.

---

### `src/utils/dcfValuation.js`

#### תפקיד

מודל **DCF (Discounted Cash Flow)** דו-שלבי, פשוט ומתועד לחלוטין, להערכת שווי הוגן (Fair Value) למניה — מודל עצמאי של AfikInvest ולא שכפול של מודל SimplyWall.st. השיטה: להצמיח את תזרים המזומנים החופשי (FCF) האחרון שדווח ל-5 שנים בקצב צמיחה שנגזר מהערכות אנליסטים, להוון את 5 השנים בתוספת ערך טרמינל (Gordon Growth) בחזרה להיום לפי עלות הון עצמי לפי CAPM, ולחלק במספר המניות להערכת שווי למניה. הקובץ מגדיר בפירוש את מגבלות המודל (הנחות מאקרו קבועות, בסיס על שנה בודדת של FCF) ומחשב דגל `isLowConfidence` כשה-FCF ההיסטורי תנודתי.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**קבועים (הנחות מאקרו קבועות, לא שאולות בזמן אמת):**
- `RISK_FREE_RATE = 0.04` (תשואת אג"ח 10 שנים אמריקאית, אומדן גס).
- `EQUITY_RISK_PREMIUM = 0.055` (פרמיית סיכון הון נהוגה לטווח ארוך).
- `TERMINAL_GROWTH_RATE = 0.025` (צמיחת תמ"ג נומינלית ארוכת טווח, אומדן גס).
- `PROJECTION_YEARS = 5`.
- `GROWTH_RATE_MIN = -0.2`, `GROWTH_RATE_MAX = 0.3` — טווח clamp לקצב הצמיחה.

**`resolveSharesOutstanding(research)`** — פותר את בעיית "מניות נסחרות" מיושנות/לא מסונכרנות: מכיוון ש-`marketCap = currentPrice × sharesOutstanding` (מוגדר תמיד באופן עקבי מתוך אותה ציטוט חי), `marketCap / currentPrice` מספק מספר מניות "מרומז" שתמיד תואם למחיר הנוכחי — בשונה מ-`sharesOutstanding` המדווח בנפרד, שיכול לפגר אחרי split או לשקף סוג מניה/תאריך דיווח אחר. מקרה אמיתי שתועד: מספר מניות ישן שגרם ל-fair value לצאת ~30x נמוך מדי מדי (הצגה אבסורדית של "-3110% overvalued"). הפונקציה מעדיפה את `impliedShares` (`marketCap/currentPrice`) כשזה תקין, ונופלת חזרה ל-`research.sharesOutstanding` המדווח כברירת מחדל.

**`computeFairValuePerShare(fcf, discountRate, growthRate, sharesOutstanding)`** — נוסחת הליבה, המשותפת לשתי הפונקציות הציבוריות. שלבים:
1. בדיקות תקינות: FCF חייב להיות חיובי, מספר מניות חיובי, ו-`discountRate > TERMINAL_GROWTH_RATE` (אחרת נוסחת Gordon "מתפוצצת").
2. הצמחת FCF ל-5 שנים והיוון:
```
for year = 1..5:
    fcfYearN *= (1 + growthRate)
    presentValueSum += fcfYearN / (1 + discountRate)^year
```
3. ערך טרמינל (Gordon Growth Model) לאחר שנה 5:
```
terminalValue = fcfYear5 × (1 + TERMINAL_GROWTH_RATE) / (discountRate - TERMINAL_GROWTH_RATE)
presentValueOfTerminal = terminalValue / (1 + discountRate)^5
```
4. סכימה וחילוק:
```
equityValue = presentValueSum + presentValueOfTerminal
fairValuePerShare = equityValue / sharesOutstanding
```
מחזירה `null` אם התוצאה אינה מספר סופי חיובי — לעולם לא ערך מפוברק.

**`hasVolatileFcfHistory(fcfSeries)`** — בודקת אם יש בהיסטוריית ה-FCF (מערך `{date, value}`) אפילו שנה אחת עם ערך ≤ 0 — אינדיקציה אובייקטיבית לתזרים מזומנים לא-יציב/מחזורי (מקרה אמיתי: FCF של Micron שהתנדנד מ-3.1 מיליארד+ ל-6.1 מיליארד- ל-0.12 מיליארד+ ל-1.7 מיליארד+ על פני 4 שנות כספים). אם קיימת כזו שנה — מודל של 5 שנות תחזית המבוסס על שנה בודדת (אפילו האחרונה) הוא הרבה פחות אמין.

**`computeDcfFairValue(research, fundamentalsHistory)`** — נקודת הכניסה הראשית:
1. שולפת `beta`, `currentPrice`, את ה-FCF האחרון מ-`fundamentalsHistory.annualFreeCashFlow`, ו-`sharesOutstanding` (via `resolveSharesOutstanding`).
2. בדיקות null-guard: `beta`, `sharesOutstanding>0`, `latestFcf>0` — אחרת `null`.
3. **עלות הון עצמי (CAPM)**: `discountRate = RISK_FREE_RATE + beta × EQUITY_RISK_PREMIUM`. אם `discountRate ≤ TERMINAL_GROWTH_RATE` (יכול לקרות ל-beta נמוך מאוד/שלילי) → `null` (המודל לא רלוונטי).
4. **קצב צמיחה שלב 1**: `rawGrowth = research.nextYearEarningsGrowth ?? research.earningsGrowth`, מוגבל (`clamp`) לטווח [-0.2, 0.3]; אם אין אומדן כלל — `growthRate = 0`.
5. קריאה ל-`computeFairValuePerShare`.
6. **מרווח בטיחות** (Margin of Safety):
```
marginOfSafetyPercent = ((fairValuePerShare - currentPrice) / fairValuePerShare) × 100
```
(`null` אם אין `currentPrice`, אבל שאר התוצאה עדיין מוחזרת).
7. מחזירה אובייקט עם `fairValuePerShare`, `currentPrice`, `marginOfSafetyPercent`, `isLowConfidence` (מ-`hasVolatileFcfHistory`), ו-`assumptions` (כל ההנחות המספריות ששימשו, לשקיפות מלאה בממשק).

**`computeDcfFairValueHistory(research, fundamentalsHistory)`** — בונה סדרת "מה היה השווי ההוגן בכל שנה עברה", תוך שימוש **בהיום's** ביתא/קצב-צמיחה/מספר-מניות (אין נתונים היסטוריים לאלה) ורק ה-FCF המדווח בכל שנה משתנה. לכל נקודה ב-`fcfSeries` מריצה את אותה `computeFairValuePerShare`. מסננת נקודות ללא תאריך/ערך. מחזירה `[]` (לא נתון מפוברק) אם אין נתונים.

**`mergeFairValueIntoPriceHistory(priceHistory, fairValueHistory)`** — "מוביל קדימה" (forward-fill) כל נקודת שווי הוגן שנתי על גבי סדרת מחירים יומית: ממיין את `fairValueHistory` לפי תאריך, ולכל נקודת מחיר יומית מוצא את אחרון ה-fair-value שתאריכו ≤ תאריך המחיר (`carried`). יום לפני נקודת ה-fair-value הראשונה מקבל `null` (לא ניחוש לאחור מפוברק). מחזיר `[]` אם `priceHistory` אינו מערך.

---

### `src/utils/dcfValuation.test.js`

בודק תרחישים רבים:
- חישוב fair value חיובי ומרווח בטיחות תקין להנחות "בריאות" (`beta=1.0`, `growth=0.08`).
- fallback ל-`earningsGrowth` כש-`nextYearEarningsGrowth` חסר.
- clamp של קצב צמיחה קיצוני (500%→30%).
- `growthRate=0` כשאין שום אומדן.
- `null` כשחסר `beta`, `sharesOutstanding` (0/null), FCF שלילי/0/חסר, או `discountRate ≤ TERMINAL_GROWTH_RATE` (למשל `beta=-0.3`).
- `currentPrice` חסר → `marginOfSafetyPercent=null` אך שאר התוצאה תקינה.
- **`isLowConfidence`**: דוגמת Micron אמיתית (FCF תנודתי, `beta=2.222`, `nextYearEarningsGrowth=1.112` שנקצץ ל-0.3) → `true`; רק כשמסתכלים על שנה בודדת → `false`; שנה עם ערך 0 גם נחשבת תנודתית.
- **shares outstanding**: בדיקה מדויקת שהתיקון בעקבות `sharesOutstanding` תקוע (30x שגוי) עובד — `marketCap/currentPrice` מייצר תוצאה גבוהה יותר מ-10x מהתוצאה עם המספר התקוע.
- `computeDcfFairValueHistory`: נקודה אחת לכל שנת FCF מדווחת, הנקודה האחרונה תואמת בדיוק ל-`computeDcfFairValue`, שנים עם FCF שלילי/0 מדולגות.
- `mergeFairValueIntoPriceHistory`: forward-fill נכון (`[null, 42, 42, 50, 50]`), שמירת שדות קיימים, `null` לפני הנקודה הראשונה, מיון נתונים לא-ממוינים, טיפול ב-`priceHistory` לא-מערך.

---

### `src/utils/dividendAnalysis.js`

#### תפקיד

בונה מדדי דיבידנד לתיק ההשקעות ממידע דיבידנד ש-Yahoo מחזיר (`server/dividendRoutes.js`) בשילוב עם ה-lots האמריקאיים בפועל של המשתמש. פונקציות טהורות (pure), מופרדות מ-hook השליפה, כדי שיהיו נבדקות באופן עצמאי.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`computeReceivedDividends(history, lots)`** — מחשבת דיבידנדים שהתקבלו בפועל על מניה אחת:
1. סוכמת את הכמות הכוללת המוחזקת בכל ה-lots: `totalQuantity = Σ lot.quantity`.
2. מוצאת את תאריך הרכישה **המוקדם ביותר** מבין כל ה-lots (`earliestPurchaseDate`).
3. אם אין תאריך רכישה מוקדם או `totalQuantity ≤ 0` → מחזירה 0.
4. מסננת מתוך `history` (מערך `{date, amountPerShare}`) רק תשלומים שתאריכם ≥ `earliestPurchaseDate`.
5. סוכמת: `Σ amountPerShare × totalQuantity` על פני כל התשלומים המתאימים.

זו **קירוב**: לא מודלת שינוי כמות אמצע-החזקה (קנייה/מכירה נוספת בין תשלומים) — אותה רוח הערה כמו "רווח מצטבר מול הפקדות" ב-`FinancialAccountsTables.js`. מוחזר ב-**USD** (המטבע שבו הדיבידנד משולם בפועל), ולא מומר לשקלים (זה ידרוש שער חליפין היסטורי מדויק לכל תאריך תשלום — נתון שלא קיים באפליקציה).

**`buildUpcomingDividendCalendar(dividendsBySymbol, todayISO)`** — לוח דיבידנדים קרובים: שורה אחת לכל סימבול אמריקאי עם תאריך אקס-דיבידנד/תשלום עתידי ידוע, מהקרוב לרחוק. לכל סימבול: `nextDate = formatEpochDateISO(data.nextDividendDateEpoch) || formatEpochDateISO(data.exDividendDateEpoch)` (עדיפות ל-nextDividendDateEpoch, fallback ל-exDividendDateEpoch). מסננת תאריכים שאינם עתידיים (`nextDate < today`) — כדי לא להציג תאריך ישן שנשאר מהתשלום האחרון (Yahoo לא מקדם אותו תמיד באופן מיידי). מחזירה שורות `{symbol, date, dividendRate, dividendYieldPercent}`, ממוינות עולה לפי תאריך.

---

### `src/utils/dividendAnalysis.test.js`

בודק: `computeReceivedDividends` — סכימת תשלומים לאחר תאריך הרכישה בלבד (0.51+0.51)×10=10.2, סכימת כמות על פני מספר lots, החרגה מלאה כשהרכישה מאוחרת מכל התשלומים, טיפול ב-input חסר/ריק בלי לזרוק שגיאה, ו-0 כשל-lots אין `purchaseDate` בכלל. `buildUpcomingDividendCalendar` — סינון+מיון לפי תאריך עתידי, fallback ל-`exDividendDateEpoch`, החרגת סימבול בלי תאריך שמיש, טיפול ב-input חסר.

---

### `src/utils/taxLossHarvesting.js`

#### תפקיד

מספק תצוגה **על פני כל התיק** של אילו החזקות נוכחיות נמצאות כעת בהפסד ריאלי (מתואם CPI/מטבע), ומה השווי הפוטנציאלי של מימוש ההפסד למטרות קיזוז מס מול רווחים ריאליים אחרים באותה שנת מס ("Tax-Loss Harvesting"). הקובץ **משתמש חזרה** באותן פונקציות חישוב רווח/מס ריאלי per-position שכבר קיימות בכל האפליקציה (`calculateStockRealGainTax`, `calculateAmericanStockMetrics`, `calculatePensionRealGainTax`, `calculateBankSavingsFundTax`) — כדי שמספר המוצג כאן יתאים תמיד למה שמוצג באותה שורת החזקה בטבלה שלה, ולא ייווצר חשבון "רווח ריאלי" שני שסוטה. מודגש בקוד: זו אינה עצה/המלצה למכור — רק זיהוי מועמדים ואומדן.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`buildIsraeliPosition(stock, cpi)`** — בונה "פוזיציה" למניה ישראלית: `displayCurrentPrice = normalizeIsraeliPrice(stock.currentPrice)`, `totalCurrentValue = displayCurrentPrice × quantity`. אם יש CPI מלא (`currentIndex` + `indexAtPurchase` שנשלף מ-`cpi.indexByMonth[monthKeyFromDate(stock.purchaseDate)]`) — מפעילה `calculateStockRealGainTax` ומשתמשת ב-`realGain` שלה. **אחרת** (אין CPI) — נופלת לחישוב רווח נומינלי שטוח: `totalCurrentValue - purchasePrice×quantity` (אותו fallback כמו ב-`IsraeliStocksTable.js`). `taxRate` תמיד 0.25.

**`buildAmericanPosition(stock)`** — קוראת ל-`calculateAmericanStockMetrics(stock)` (מ-`portfolioMath.js`) ומשתמשת ב-`metrics.realGainILS`. `taxRate` = 0.25.

**`buildPensionPosition(fund, cpi)`** — `fundCurrentValue = fund.currentValue ?? fund.amount ?? 0`. אם יש `currentIndex` — `calculatePensionRealGainTax` על ה-deposits; אחרת — `gain = fundCurrentValue - Σ deposits.amount` (סכום נומינלי). קופות גמל **תמיד** ב-`taxRate=0.25` (אין מסלול נומינלי לקופת גמל, לפי ההערות בקובץ).

**`buildBankSavingsPosition(fund, cpi)`** — `currentValue = computeBankSavingsFundValue(fund)` (מ-`bankSavingsFund.js`, ריבית-דריבית). קוראת ל-`calculateBankSavingsFundTax` עם `isLinkedToIndex` בפועל. `taxRate = fund.isLinkedToIndex && currentIndex ? 0.25 : 0.15` (משקף את הכפילות של הבחירה: צמוד+יש-מדד → 25%, אחרת 15%).

**`computeTaxLossHarvestingOpportunities(israeliStocks, americanStocks, pensionFunds, cpi, bankSavingsFunds)`** — הפונקציה הראשית:
1. בונה מערך `positions` משילוב כל ארבע הקטגוריות (Israeli/American/Pension/BankSavings), כל אחת עם `realGain` ו-`taxRate`.
2. **`lossPositions`** — כל פוזיציה עם `realGain < 0`, ממופה ל-`{..., harvestableLoss: -realGain, taxValue: -realGain × taxRate}` (שני שדות חיוביים), ממוינת מההפסד הגדול ביותר לקטן.
3. **`gainPositions`** — כל פוזיציה עם `realGain > 0`, ממופה ל-`{..., taxValue: realGain × taxRate}`, ממוינת מהרווח הגדול לקטן.
4. סכומים: `totalHarvestableLoss` (Σ הפסדים בר-מימוש), `totalPotentialTaxValue` (Σ שווי המס הפוטנציאלי מקיזוז), `totalCurrentGains` (Σ רווחים ריאליים נוכחיים), `totalGainsTax` (Σ המס על אותם רווחים).
5. מחזירה אובייקט מלא עם כל אלה + `hasLossPositions`/`hasGainPositions` בוליאניים.

---

### `src/utils/taxLossHarvesting.test.js`

בודק: תיק ריק מחזיר תוצאה ריקה/מאופסת; מניה ישראלית בהפסד נומינלי (בלי CPI) מסווגת כ-loss position עם `harvestableLoss` ו-`taxValue=×0.25`; **בדיקת regression** מפורשת שמחיר שקלי גבוה לגיטימי (₪2,457) לא מחולק פעם שנייה ב-100 (מבטיחה ש-`normalizeIsraeliPrice` לא מפרק תוצאות); מניה ישראלית רווחית מסווגת ל-gain positions; מניה אמריקאית בהפסד ריאלי (ללא תזוזת FX, אז ריאלי=נומינלי); קופת גמל תמיד ב-25% (בלי מסלול נומינלי); קופת חיסכון בבנק לא-צמודה ברווח ↦ 15%; קופת חיסכון צמודה בהפסד (עם CPI) ↦ 25%; מיון הפסדים מהגדול לקטן; סכימת totals נכונה על תמהיל loss+gain; והשפעה של נתוני CPI על הסיווג (בלי CPI: רווח נומינלי 5, לא הפסד; עם CPI: הרווח מתאפס בגלל הפטור האינפלציוני, ולא מופיע גם כ-gain position).

---

### `src/utils/bankSavingsFund.js`

#### תפקיד

מחשב **שווי נוכחי** לקופת חיסכון בבנק בצורה אוטומטית — בשונה מקופת גמל (ששוויה מתעדכן ידנית ע"י המשתמש), כאן הריבית שהמשתמש הזין אמורה לגדל את הכסף אוטומטית: כל הפקדה צומחת בריבית-דריבית שנתית מתאריך ההפקדה שלה ועד לתאריך המבוקש (כברירת מחדל — היום), ואין שדה "שווי נוכחי" נפרד לעדכן.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`MS_PER_YEAR = 1000 × 60 × 60 × 24 × 365.25`** — שנה ממוצעת (עם התחשבות בשנים מעוברות).

**`yearsBetween(fromDateStr, toDate = new Date())`** — מחשבת מספר שנים חלקי שחלפו:
```
years = max(0, (to - from) / MS_PER_YEAR)
```
מחזירה `0` אם התאריכים לא תקינים (`NaN`), ולעולם לא מספר שלילי (תאריך הפקדה עתידי → clamp ל-0).

**`computeBankSavingsFundValue(fund, asOfDate = new Date())`** — נוסחת ריבית-דריבית לכל הפקדה בנפרד, מסוכמות:
```
ערך = Σ_over deposits [ amount × (1 + annualRate)^years ]
```
כאשר `annualRate = fund.interestRate / 100` (המרה מאחוזים) ו-`years = yearsBetween(deposit.date, asOfDate)` **עבור אותה הפקדה בלבד** (כל הפקדה גדלה מהתאריך שלה, לא מתאריך משותף). מחזירה 0 אם `fund`/`deposits` חסר/ריק.

---

### `src/utils/bankSavingsFund.test.js`

בודק: `yearsBetween` — שנה אחת בין 2023-01-01 ל-2024-01-01 (≈1, עם דיוק 2 עשרוני), תאריך עתידי מחזיר 0 (לא שלילי), תאריך לא-תקין מחזיר 0. `computeBankSavingsFundValue` — הפקדה בודדת בריבית 10% ↦ ~1100 אחרי שנה (דיוק 0 עקב חישוב 365.25 ימים); **שנתיים** ריבית-דריבית ב-10% ↦ ~1210 (**לא** 1200 — מוכיח שזה ריבית-דריבית אמיתית ולא ריבית פשוטה); מספר הפקדות שכל אחת גדלה מתאריכה שלה ומסוכמות (1000@1yr≈1100 + 500@0yr=500 → ~1600); ריבית 0% מחזירה את הסכום המקורי בלי שינוי; ללא הפקדות ↦ 0; קרן חסרה/מלוכלכת מטופלת בחן (מחזיר 0).

---

### `src/utils/earningsCalendar.js`

#### תפקיד

בונה לוח תאריכי דוחות (Earnings) עתידיים להחזקות אמריקאיות. שולף מאותו מקור נתונים per-symbol שסקציית מעקב הדיבידנדים כבר משתמשת בו (`useDividendData`/`server/dividendRoutes.js`) — מודול `calendarEvents` של Yahoo מחזיר בבת אחת גם תאריכי דוחות וגם תאריכי דיבידנד, כך שאין צורך ב-fetch/hook נפרד. נשמר כמודול נפרד מ-`dividendAnalysis.js` כי "תאריך דוח קרוב" ו"מעקב דיבידנד" הן שאלות שונות לקורא, גם אם שתיהן חולקות מקור מידע.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`buildUpcomingEarningsCalendar(dividendsBySymbol, todayISO)`** — שורה אחת לכל סימבול אמריקאי עם תאריך דוח עתידי ידוע, מהקרוב לרחוק:
1. `today = todayISO || new Date().toISOString().slice(0,10)`.
2. לכל `[symbol, data]` ב-`dividendsBySymbol`: `date = formatEpochDateISO(data.earningsDateEpoch)`.
3. סינון: מדלגת אם אין תאריך שמיש או שהתאריך עבר (`date < today`) — כמו ב-`buildUpcomingDividendCalendar`, כי הערכה ישנה שנשארה מהדוח הקודם לא רלוונטית ל"קרוב".
4. בונה שורה `{symbol, date, isEstimate: data.isEarningsDateEstimate ?? null, epsEstimateAverage: data.epsEstimateAverage ?? null, revenueEstimateAverage: data.revenueEstimateAverage ?? null}`.
5. ממיינת עולה לפי תאריך.

---

### `src/utils/earningsCalendar.test.js`

בודק: סינון+מיון תאריכים עתידיים בלבד (מהקרוב לרחוק) עם השדות הנכונים בשורה (`isEstimate`, `epsEstimateAverage`, `revenueEstimateAverage`); סימבול בלי תאריך דוח בכלל מוחרג; טיפול ב-input ריק/חסר בלי לזרוק שגיאה; ברירת מחדל ל"היום" האמיתי כש-`todayISO` לא נשלח (תאריך משנת 2000 ייצא מהרשימה).

---

### `src/utils/monthlySnapshotBreakdown.js`

#### תפקיד

בונה את הפירוט הפריטני (itemized breakdown) שנשמר עם כל checkpoint חודשי/יומי של התיק (ראו `hooks/usePortfolioSnapshots.js`, `hooks/useMonthlySnapshots.js`) — שורה אחת לכל החזקה/חשבון אמיתי, מקובצת תחת אותן 5 (בפועל 6) קטגוריות שמשמשות בכל האפליקציה (ראו `monthlySnapshotComparison.js`). משתמש חזרה ב-`analysis.stockDistribution` הקיים למניות ישראליות/אמריקאיות (כבר מחושב, ושדה `value` שלו הוא שווי שוק טהור בלי מס/רווח מעורבב — אין צורך "לנקות" אותו). לפריטי קופת גמל/קרן כספית/בנק, שאין להם פילוג קיים במקום אחר, נבנים ישירות מהמערכים הגולמיים.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`buildItemizedMonthlyBreakdown(analysis, pensionFunds, cashFunds, bankBalances, bankSavingsFunds = [])`**:
1. **israeli/american** — עוברת על `analysis.stockDistribution`, לכל מניה בונה `{key: stock.name, label: stock.name, value: stock.value}` ומכניסה לרשימה המתאימה לפי `stock.exchange`.
2. **pension** — לכל קרן: `{key: fundName || 'pension-{id}', label: fundName || 'קופת גמל', value: toNum(item.currentValue != null ? item.currentValue : item.amount)}` (עדיפות ל-`currentValue`, fallback ל-`amount`).
3. **cashFunds** — `{key: fundName || 'cash-{id}', label: fundName || 'קרן כספית', value: toNum(item.amount)}`.
4. **bank** — `{key: 'bank-{index+1}', label: bankBalances.length>1 ? 'עו"ש #{index+1}' : 'עו"ש', value: toNum(item.amount)}` — תיוג מספרי רק כשיש יותר מחשבון בנק אחד.
5. **bankSavings** — `{key: fundName || 'bank-savings-{id}', label: fundName || 'קופת חיסכון בבנק', value: toNum(computeBankSavingsFundValue(item))}` (משתמש בפונקציית הריבית-דריבית מ-`bankSavingsFund.js`).
מחזירה `{israeli, american, pension, cashFunds, bank, bankSavings}` — שישה מערכים, כל אחד ריק כברירת מחדל, ולעולם לא פריט מפוברק.

---

### `src/utils/monthlySnapshotBreakdown.test.js`

בודק: פיצול `stockDistribution` נכון ל-israeli/american, בלי שדות רווח/מס מוזרים; בניית פריט אחד לכל קופת גמל, כולל fallback ל-`amount` כש-`currentValue` חסר; פריט אחד לכל קרן כספית; חשבון בנק בודד מתויג "עו"ש" רגיל, מספר חשבונות ממוספרים ("#1", "#2"); פריט אחד לכל קופת חיסכון בבנק; קטגוריה ריקה מחזירה מערך ריק ולא פריט מפוברק; טיפול ב-`analysis`/`stockDistribution` חסרים.

---

### `src/utils/monthlySnapshotComparison.js`

#### תפקיד

לוגיקת ההשוואה בין שני checkpoints חודשיים (ראו `hooks/useMonthlySnapshots.js`) — מופרד מהקומפוננטה כדי שיהיה נבדק ישירות ביחידה, בהתאם לעקרון הכללי של האפליקציה (חישובים ב-`utils/*.js`, לא inline בקומפוננטה). מפתחות/תוויות הקטגוריה תואמים ל-`analysis.exchangeDistribution` — אותן 6 קטגוריות שמשמשות ב-`PortfolioAnalysisView.js`. ערך הפילוג של כל קטגוריה יכול להיות בשתי צורות: מערך פריטני (`{key,label,value}[]`, ראו `monthlySnapshotBreakdown.js`) או, בסנפשוטים ישנים שנשמרו לפני שהיה פילוג פריטני, מספר שטוח בודד לכל הקטגוריה — `normalizeCategoryItems()` מתייחסת לשתי הצורות באופן זהה, כך ששני סוגי הסנפשוטים משתווים נכון ללא מיגרציית דאטה.

חלק מרכזי בקובץ הוא **התאמת תרומות (Contribution Adjustment) לפי Modified Dietz** — כדי שהפקדה/רכישה/משיכה/מכירה שקרו בתוך התקופה לא יימנו כ"צמיחת השקעה" בטעות. שני מקורות תזרימי מזומנים:
1. **תזרימים שמזוהים אוטומטית** (`buildLiveCashFlows`) — לקטגוריות עם פנקס מתועד אמיתי (lots של רכישת מניות, הפקדות קופת גמל/חיסכון בנק), נשלף ישירות מהתיק החי, בלי צורך בהזנת משתמש. רואה רק כניסות כסף (אין פנקס מכירה/משיכה באפליקציה).
2. **תזרימים שמוצהרים ידנית** (`buildManualCashFlows`) — סכום נטו שהמשתמש מזין לכל קטגוריה, נשמר על הסנפשוט עצמו כ-`breakdown.cashFlows`. זהו המקור **היחיד** לעו"ש/קרנות כספיות (שאין להן פנקס בכלל), והדרך היחידה לתעד מכירה/משיכה בכל קטגוריה.

השניים **מצטברים** לכל קטגוריה.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**קונסטנטים**: `MONTHLY_CATEGORY_KEYS = ['israeli','american','pension','cashFunds','bank','bankSavings']`. `CONTRIBUTION_ADJUSTABLE_CATEGORIES = ['israeli','american','pension','bankSavings']` (קטגוריות עם פנקס מתועד — ללא bank/cashFunds). `MONTHLY_CATEGORY_LABELS_HE` — מיפוי תוויות עבריות.

**`percentChange(base, compare)`**:
```
percent = ((compare - base) / |base|) × 100
```
מחזירה `null` (לא 0/Infinity) אם `base` הוא 0 או שאחד הצדדים אינו מספר סופי.

**`normalizeCategoryItems(categoryValue, categoryKey)`** — אם מערך, מסננת פריטים תקינים; אם מספר סופי, עוטפת ל-`[{key: categoryKey, label, value: categoryValue}]`; אחרת `[]`.

**`buildLiveCashFlows(liveHoldings)`** — בונה Map (לכל קטגוריה) של מפתח פריט → מערך `{date, amount}`, מהתיק החי (לא מהסנפשוטים עצמם, שלא שמרו היסטוריית תזרימים — רק מצב נקודתי-בזמן). עבור israeli: `amount = purchasePrice × quantity`. עבור american: `amount = purchasePrice × quantity × exchangeRate` (עלות בשקלים, לפי שער בעת הרכישה — תואם `totalPurchaseILS` בכל שאר האפליקציה). עבור pension/bankSavings: מסכם ישירות מ-`fund.deposits`.

**`flowsInPeriod(flowList, periodStart, periodEnd)`** — מסננת תזרימים בטווח `(periodStart, periodEnd]` (חצי-פתוח מהצד הראשון) — תזרים בתאריך שווה בדיוק ל-`periodStart` נחשב **כבר** משוקף בערך ההתחלה, לא כ"חדש".

**`monthEndDateString(monthKey)` / `nextMonthStartDateString(monthKey)`** — עוזרות תאריך בנויות עם `Date.UTC` (לא constructor מקומי) כדי למנוע שינוי יום עקב אזור זמן.

**`buildManualCashFlows(allSnapshots, baseMonth, compareMonth)`** — עבור כל סנפשוט ששייך ל-`(baseMonth, compareMonth]`, שולפת `breakdown.cashFlows[key]` (אם קיים וסופי ו-≠0) ותאריכה לסוף אותו חודש (`monthEndDateString`). מאפשרת השוואה מרובת-חודשים (למשל ינואר מול יוני) לתפוס תזרימים שהוצהרו במרץ/אפריל/מאי בנפרד.

**`isLegacyRollup(items, categoryKey)`** — מחזירה `true` כאשר `items` הוא רק העטיפה הסינתטית של `normalizeCategoryItems` על מספר שטוח ישן (לא פירוט פריטני אמיתי) — מאפשרת ל-UI להציג "אין פירוט זמין" באופן כן.

**`adjustedChangePercent({baseValue, compareValue, cashFlows, periodStart, periodEnd})`** — מפעילה **Modified Dietz** (מ-`modifiedDietz.js`, לא בקובץ זה) מעל שינוי אחוזי נאיבי:
```
naive = percentChange(baseValue, compareValue)
```
אם אין `naive`, או שאין תקופה/תזרימים — מחזירה את הנאיבי בלי התאמה (`contributionAdjusted:false`). אחרת קוראת ל-`calculateModifiedDietzReturn` (חוזה `{beginningValue, endingValue, cashFlows, periodStart, periodEnd}`) ומחזירה `{changePercent, rawChangePercent, netCashFlow, contributionAdjusted:true}` — כש-0 תזרימים רלוונטים, Modified Dietz שווה בדיוק לנוסחה הנאיבית, כך שהחלה תמיד בטוחה.

**`compareMonthlySnapshots(baseSnapshot, compareSnapshot, liveHoldings=null, allSnapshots=[])`** — הפונקציה הראשית:
1. גבולות תקופה: `periodStart = nextMonthStartDateString(baseSnapshot.month)` (1 לחודש **הבא** אחרי חודש הבסיס — כל דבר בחודש הבסיס עצמו נחשב כבר משוקף ב-baseValue, מה שמונע ניכוי כפול), `periodEnd = monthEndDateString(compareSnapshot.month)`.
2. מחשבת `liveCashFlows` ו-`manualCashFlows` ומגדירה `categoryFlowsInPeriod(key)` — צירוף אוטומטי+ידני, מסונן לתקופה.
3. לכל קטגוריה: מנרמלת פריטי base/compare, מתאימה פריטים על פי מפתח (`itemKeys` = איחוד מפתחות), ולכל פריט קוראת ל-`adjustedChangePercent`. פריט שקיים רק בצד אחד (נקנה/נמכר) מקבל `null` לצד השני, **לא 0**.
4. חשבון `baseTotal`/`compareTotal` (סכום ערכי הפריטים), עם `baseValue/compareValue = null` אם הקטגוריה ריקה באחד הצדדים (ולא 0 מפוברק).
5. שורת `totalRow` — נגזרת מ-`totalValueILS` (לא מסכום הקטגוריות), עם `partiallyAdjusted=true` אם קטגוריה בלי פנקס (bank/cashFunds) ובלי נתונים ידניים כלל לא נוקתה — סימן שהתאמת הסה"כ אינה מלאה.
מחזירה מערך שורות: אחת לכל 6 הקטגוריות + שורת "total" נגררת.

---

### `src/utils/monthlySnapshotComparison.test.js`

בודק תרחישים רבים: שישה שורות קטגוריה + שורת סה"כ; סכימת `baseValue`/`compareValue` וחישוב אחוז נכון לקטגוריית american; התאמת פריטים לפי מפתח (PLTR/AAPL); פריט שנקנה רק בחודש ההשוואה מקבל `baseValue=null` (לא 0); פריט שנמכר עד חודש ההשוואה מקבל `compareValue=null`; שורת total מבוססת על `totalValueILS` בלבד; קטגוריה חסרה בצד אחד ↦ `null`; **תאימות לאחור** עם סנפשוטים ישנים (מספר שטוח) — קטגוריה שטוחה מציגה ערך תקין אך פריט שאין לו התאמה בצד השני. בדיקה ש-base=0 מייצר `null` ולא Infinity/NaN. בדיקות ריקות (חסר snapshot). **בדיקות Modified Dietz** — רכישה בתוך התקופה מנוכה מהאחוז הנאיבי המטעה (60%→<20%); התאמה מתבצעת גם ברמת פריט; קטגוריות בלי פנקס (bank/cashFunds) נותרות ללא התאמה; הפקדת קופת גמל מנוטרלת דרך פנקס ה-deposits שלה; בלי `liveHoldings` אין התאמה בכלל; שורת total מסומנת `partiallyAdjusted`; רכישה **בתוך** חודש הבסיס עצמו (לא רק לפניו) לא נכללת (regression חשוב — עלולה לגרום לניכוי כפול); רכישה מלפני התקופה לא נספרת. בדיקות **תזרימים ידניים** — הפקדה מוצהרת בקטגוריית עו"ש (שאין לה פנקס); סכום שלילי (משיכה/מכירה) מנוטרל סימטרית; בלי `allSnapshots` תזרימים ידניים מוזנחים לגמרי (תאימות לאחור); תזרים בחודש ביניים נתפס בהשוואה מרובת-חודשים; תזרים מחוץ לטווח לא נתפס; תזרימים אוטומטיים+ידניים באותה קטגוריה מצטברים; שורת total מפסיקה להיות `partiallyAdjusted` רק כשלכל הקטגוריות בלי פנקס יש נתונים מוצהרים; ו-`buildManualCashFlows` — איסוף תקין, החרגת סנפשוט בגבול/מעבר לטווח, התעלמות מ-0/חסר, נוכחות כל המפתחות תמיד, וטיפול ב-input שגוי.

---

### `src/utils/analystData.js`

#### תפקיד

פונקציות עזר לפרשנות ותרגום נתוני סיקור אנליסטים מ-Yahoo (מודולים `financialData` + `recommendationTrend` + `upgradeDowngradeHistory`, ראו `server/yahooQuotes.js:fetchYahooAnalystData`). פונקציות טהורות, מופרדות מ-hook השליפה לבדיקת יחידה עצמאית.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`RECOMMENDATION_LABELS_HE`** — מיפוי מפתחות (`strong_buy`, `buy`, `hold`, `underperform`, `sell`, `strong_sell`, `none`) לתוויות עבריות ("קנייה חזקה" וכו').

**`recommendationLabelHe(recommendationKey)`** — מנרמלת ל-lowercase, מחפשת במיפוי; fallback למחרוזת הגולמית אם המפתח לא מוכר; `'לא ידוע'` אם חסר לגמרי.

**`recommendationSentiment(recommendationKey)`** — למחלקות CSS: `strong_buy`/`buy` → `'positive'`; `sell`/`strong_sell`/`underperform` → `'negative'`; `hold` (או כל דבר אחר) → `null` (נטרלי, בלי מחלקה).

**`computeUpsidePercent(currentPrice, targetMeanPrice)`** — נוסחת "אפסייד" בין המחיר הנוכחי למחיר המטרה הממוצע של האנליסטים:
```
upside% = ((targetMeanPrice - currentPrice) / currentPrice) × 100
```
חיובי = מחיר המטרה מעל המחיר הנוכחי. `null` אם אחד הקלטים חסר/0.

**`ACTION_LABELS_HE`** — מיפוי קודי `upgradeDowngradeHistory.action` (`up`,`down`,`main`,`init`,`reit`) לתוויות ("שדרוג","הורדה","שימור דירוג","תחילת סיקור","אישור דירוג").

**`actionLabelHe(action)`** — מנרמלת ומחפשת במיפוי, fallback למחרוזת הגולמית, `''` אם חסר.

**`formatEpochDateISO(epochSeconds)`** — ממירה שניות-Unix לתאריך ISO (`YYYY-MM-DD`) דרך `new Date(epochSeconds*1000).toISOString().slice(0,10)`. `null` אם הקלט לא מספר סופי.

**`totalTrendOpinions(currentTrend)`** — סוכמת את כל הדלי'ים המספריים (`strongBuy, buy, hold, sell, strongSell`) בחבילת `recommendationTrend` הנוכחית; `null` אם אין ערכים מספריים כלל.

---

### `src/utils/analystData.test.js`

בודק: תרגום נכון (case-insensitive) של מפתחות המלצה מוכרים לעברית, fallback למפתח הגולמי למפתחות לא מוכרים, `'לא ידוע'` ל-`null`/`undefined`; sentiment חיובי/שלילי/נטרלי לפי סוג ההמלצה; `computeUpsidePercent` — חיובי/שלילי/`null` (כולל `currentPrice=0`); תרגום קודי action מוכרים וטיפול חן בערכים ריקים/לא מוכרים; המרת epoch נכונה (`1735689600 → '2025-01-01'`) ו-`null` לקלט לא סופי; סכימת `totalTrendOpinions` ו-`null` לחוסר נתונים/דלי'ים ריקים.

---

### `src/utils/newsFeed.js`

#### תפקיד

מאחד פיד חדשות per-symbol (`server/newsRoutes.js`, דרך `useStockNews`) לפיד משולב, ללא כפילויות, ממוין מהחדש לישן. פונקציה טהורה, מופרדת מה-hook כדי לבדוק אותה בנפרד.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`buildNewsFeed(newsBySymbol, limit = 20)`**:
1. עוברת על כל הצמדים `[symbol, items]` ב-`newsBySymbol`.
2. לכל כתבה (`item`) — מדלגת אם אין `uuid` (מקרה פסול).
3. **דדופ**: אם ה-`uuid` נראה כבר (`byUuid.get(item.uuid)`), רק מוסיפה את `symbol` הנוכחי ל-`relatedSymbols` של הכתבה הקיימת (אם לא קיים בו כבר) — כתבה בודדת יכולה להזכיר כמה טיקרים מהתיק ולהופיע תחת כל אחד מהם ב-`newsBySymbol`, אבל מופיעה **פעם אחת** בפיד המשולב.
4. אחרת — יוצרת כניסה חדשה עם `{uuid, title, publisher, link, publishedAtEpoch, date: formatEpochDateISO(publishedAtEpoch), relatedSymbols: [symbol]}`.
5. ממיינת את כל הערכים לפי `publishedAtEpoch` (מהגדול לקטן — חדש לישן), עם `|| 0` להגנה מפני חסר.
6. חוצצת (`slice`) ל-`limit` (ברירת מחדל 20).

---

### `src/utils/newsFeed.test.js`

בודק: מיון לפי עדכניות (חדש→ישן) על פני שני סימבולים; דדופ של כתבה משותפת המוזכרת תחת שני סימבולים, עם מיזוג `relatedSymbols`; הגבלת `limit` (30 כתבות → 5 בפועל); דילוג על כתבה בלי `uuid` בלי לזרוק שגיאה; טיפול ב-input ריק/חסר/null.

---

### `src/utils/financialVisuals.js`

#### תפקיד

פונקציות בנייה טהורות שממירות `fundamentalsHistory` (ראו `fetchYahooFundamentalsTimeseries` ב-`server/yahooQuotes.js`) ו-`priceHistory` לצורות הנתונים שהגרפים המתקדמים ("phase 2") ב-`StockResearchView.js` צריכים: דונאט התפלגות הכנסות, גרף עמודות מגמת הכנסה/רווח-נקי, treemap מאזן, ROCE, ו-P/E היסטורי. אין שליפת נתונים כאן, ואין החלטות עיצוב מעבר למה שהגרף צריך — כל פונקציה מחזירה `null`/`[]` (לעולם לא placeholder מפוברק) כשחסרים שדות נחוצים, אותו עקרון כמו בבדיקות `stockScorecard.js`.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`latestValue(series)`** — הערך האחרון במערך `{date, value}` (או `null` אם ריק/לא מערך).

**`findNearestPricePoint(priceHistory, dateStr, maxDiffMs = 30 יום)`** — מוצאת את נקודת ה-`priceHistory` (`{date, close}`) שהתאריך שלה הקרוב ביותר ל-`dateStr`, בתנאי שהמרחק לא עולה על `maxDiffMs` (התאמה רחוקה מזה נחשבת "אין התאמה" ולא התאמה מטעה). מחשבת הפרש זמן מוחלט לכל נקודה ובוחרת את המינימלי. נמצאת בשימוש גם ב-`buildHistoricalPeSeries` וגם לסימוני דיבידנד בגרף מחיר ב-`StockResearchView.js`.

**`buildRevenueBreakdown(fundamentalsHistory)`** — התפלגות הכנסות לשנה האחרונה: `revenue = latestValue(annualTotalRevenue)`; אם `≤ 0`/חסר → `null`. לוקחת ערכים אחרונים (עם fallback ל-0) עבור `cogs, opEx, interest, tax, netIncome`, מבנה שכבות `{key, label (עברית), value: |ערך|}`, מסננת שכבות עם `value ≤ 0`. מחשבת `accountedFor = Σ slices.value` ו-`residual = revenue - accountedFor`; אם `residual > revenue × 0.02` (מעל 2%) — מוסיפה שכבת `'other'` ("אחר") — שאריות קטנות (עגילה, פריטים לא-מסווגים ב-Yahoo) לא מוצגות כשכבה. מחזירה `null` אם אין שכבות בכלל.

**`buildRevenueTrend(fundamentalsHistory)`** — מצמידה הכנסה + רווח נקי לכל שנת דיווח, לגרף עמודות מגמה: לכל נקודה ב-`annualTotalRevenue`, `year = date.slice(0,4)`, `netIncome` נשלף ממפת `Map` שנבנתה מ-`annualNetIncome` (לפי תאריך תואם), או `null` אם אין נתון מתאים לאותה שנה. `null` אם אין סדרת הכנסה כלל.

**`buildBalanceSheetTreemap(fundamentalsHistory)`** — מאזן שנה אחרונה, מחולק לשתי קבוצות בפורמט שדרוש ל-Treemap של recharts (`{name, children}` מקונן): **נכסים** (`נכסים שוטפים`, `רכוש קבוע`, `מוניטין ונכסים בלתי מוחשיים`, `מזומן ושווי מזומן`) ו-**התחייבויות והון** (`התחייבויות שוטפות`, `חוב לזמן ארוך`, `הון עצמי`) — כל אחד מסונן ל-`value` חיובי בלבד (מדלג ערך 0/שלילי, במקום להציג "שכבה מזויפת"). מחזירה `null` אם שתי הקבוצות ריקות.

**`computeLatestRoce(fundamentalsHistory)`** — נוסחת **ROCE** (Return on Capital Employed):
```
ROCE = EBIT / investedCapital
```
(`ebit = latestValue(annualEBIT)`, `investedCapital = latestValue(annualInvestedCapital)`). `null` אם `investedCapital` חסר או שווה 0. הערה: ROE/ROA באים מוכנים מ-`research.returnOnEquity`/`returnOnAssets` (יחסים חושבו כבר ע"י Yahoo) — רק ROCE צריך לגזור אותו בעצמנו.

**`buildHistoricalPeSeries(epsSeries, priceHistory)`** — P/E היסטורי משוער: לכל שנה עם EPS מדולל מדווח (`epsPoint.value > 0`), מוצאת את המחיר הקרוב ביותר ב-`priceHistory` (עד 30 יום הפרש, דרך `findNearestPricePoint`) ומחשבת:
```
P/E = closestClose / epsPoint.value
```
מדלגת (`filter(Boolean)`) שנים ללא EPS חיובי או ללא התאמת מחיר. זו הערכה **מוצהרת** (מחיר סוף-שנה חלקי EPS דוחות אמיתי אותה שנה) — ולא סדרת P/E היסטורית מקורית של Yahoo (לא זמינה ב-API הזה). מחזירה `null` אם אין נקודות כלל.

---

### `src/utils/financialVisuals.test.js`

בודק: `buildRevenueBreakdown` — בניית שכבות משנה אחרונה עם השמטת שאריות קטנות; הוספת שכבת "אחר" כשהשארית משמעותית; `null` כשההכנסה חסרה. `buildRevenueTrend` — התאמת הכנסה+רווח נקי לפי שנה, `null` כשאין סדרת הכנסה, `netIncome=null` לשנה בלי נתון מתאים. `buildBalanceSheetTreemap` — בניית שתי קבוצות עם ילדים תקינים (מוניטין חסר מדולג), `null` כשאין נתונים, שכבה עם ערך 0/שלילי מוסרת. `computeLatestRoce` — חלוקת EBIT/investedCapital, `null` ל-investedCapital חסר/0. `findNearestPricePoint` — התאמה תקינה בטווח, `null` להתאמה רחוקה מ-30 יום, `null` ל-input ריק/לא-תקין. `buildHistoricalPeSeries` — התאמה נכונה של EPS למחיר קרוב וחישוב P/E, השמטת שנה עם EPS לא-חיובי, `null` כשאחת הסדרות חסרה.

---

### `src/utils/formatters.js`

#### תפקיד

פונקציות עיצוב ועזר טהורות המשמשות בכל האפליקציה — הופקו (extracted) מ-`App.js` בלי לשנות התנהגות, רק מיקום. מרכזי בקובץ: **תיקון bug production אמיתי** בנוגע לנרמול מחירי מניות ישראליות (מחיר בשקלים שהיה מחולק פעם שנייה ב-100 באופן שגוי).

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`formatDate(dateString)`** — `new Date(dateString).toLocaleDateString('he-IL')` (פורמט `d.m.yyyy`).

**`formatPrice(price)`** — `null`/`undefined`/`NaN` → `'0.00'`; אחרת `price.toFixed(2)` ואז `toLocaleString('he-IL', {min/maxFractionDigits:2})` — כלומר מחיר עם 2 עשרוניים ומפרידי אלפים (למשל `1234.5 → '1,234.50'`).

**`formatPriceWithSign(price)`** — כמו `formatPrice` אבל עם **מקף מסחרי בסוף** (לא בתחילת) המספר לערכים שליליים — מוסכמת RTL עברית (`-125 → '125.00-'`). אפס אינו נחשב שלילי.

**`normalizeIsraeliPrice(price)`** — **תיקון bug מרכזי**: הפונקציה **לא** מחלקת ב-100 יותר (בשונה מגרסה קודמת שהניחה "אם מספר > 1000 זה כנראה עדיין אגורות"). הרציונל המלא בהערה: כל נתיב קוד שכותב ל-`stock.currentPrice` (fetch ראשוני ב-`App.js`, לופ עדכון חי ב-`usePriceRefresh.js`, ומיגרציית טעינה חד-פעמית ב-`normalizeIsraeliStocksFromStorage`) ממיר אגורות→שקלים כבר לפני שהערך מגיע ל-state; ה-heuristic הישן היה שגוי לכל מניה מעל ~1000 ש"ח (מחיר אמיתי של ₪2,457 היה מוצג כ-₪24.57 — שגיאת פי-100). כעת הפונקציה רק מבצעת coercion טיפוסים (string→number, null/NaN→0) בלי חלוקה.

**`calculateProfitPercentage(purchaseValue, currentValue)`**:
```
percent = ((currentValue - purchaseValue) / purchaseValue) × 100
```
מוחזר כ-string עם `.toFixed(2)`. מחזירה `0` (מספר, לא string) אם `purchaseValue` הוא 0/falsy או `currentValue` falsy (הגנת חלוקה-ב-0).

**`profitClass(value)`** — `(value||0) >= 0 ? 'profit-positive' : 'profit-negative'` — מרכזת בדיקה שהופיעה כ-36 פעמים ב-2 טבלות המניות.

**`formatDailyChangePercent(value)`** — `value.toFixed(2)` אם לא null/undefined, אחרת `'0.00'`.

**`toNum(v)`** — `Number(v)` עם fallback ל-0 אם `!Number.isFinite`.

**`normalizeIsraeliStocksFromStorage(parsed)`** — מיגרציה חד-פעמית לטעינת מניות ישראליות מ-localStorage (רץ בכל טעינת תיק, ראו `usePortfolioData.js`). **גם כאן תוקן ה-bug הזהה**: פעם היה מחלק ב-100 כש"נראה גדול מדי", אבל כיוון שהפונקציה רצה **בכל** טעינה (לא חד-פעמית באמת), מניה יקרה לגיטימית הייתה מתחלקת שוב ושוב בכל רענון. כעת רק מבצעת coercion (string→number, null/NaN→0) בלי חלוקה. מחזירה `[]` לקלט לא-מערך.

---

### `src/utils/formatters.test.js`

בודק: `formatPrice` — פורמט תקין עם פסיקים ו-2 עשרוניים, `'0.00'` ל-null/undefined/NaN. `formatPriceWithSign` — בלי מינוס לחיובי, מינוס **בסוף** לשלילי, אפס לא נחשב שלילי. `normalizeIsraeliPrice` — **regression מפורש**: `2457 → 2457` (לא `24.57`); מספרים קטנים/גדולים ללא שינוי; string נשלטת ל-number בלי חלוקה; null/undefined/NaN → 0. `calculateProfitPercentage` — רווח/הפסד תקין (`'20.00'`/`'-20.00'`), הגנת חלוקה-ב-0 (`purchaseValue=0 → 0`). `normalizeIsraeliStocksFromStorage` — regression זהה (מחיר ₪2,457 לא מתחלק בכל טעינה), ללא שינוי לפי magnitude, coercion string, null/NaN→0, array לא-חוקי→`[]`. `toNum` — המרה תקינה, 0 לקלט לא-חוקי. `profitClass` — positive/negative/null→positive. `formatDailyChangePercent` — עיצוב 2 עשרוניים, fallback ל-0.00, 0 מפורמט כ-'0.00' ולא כ"חסר". `formatDate` — פורמט `he-IL` (`'2023-01-15' → '15.1.2023'`).

---

### `src/utils/exportData.js`

#### תפקיד

עיצוב שורות (row-shaping) לייצוא תיק ההשקעות (Excel/PDF) — פונקציות טהורות, בלי קריאות לספריות ייצוא, כדי שיהיו נבדקות ושמישות חזרה לשני הפורמטים. משתמש חזרה באותם חישובים שכל טבלה כבר מציגה (`normalizeIsraeliPrice`, `calculateAmericanStockMetrics`, `calculatePensionPeriodReturn`) במקום לחשב totals בדרך שונה — כדי להימנע מחזרה על אותם bugs של יחידות מטבע (אגורות/₪) שכבר קרו יותר מפעם אחת בפרויקט.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`round2(n)`** — `Math.round((n||0) × 100) / 100` — עיגול ל-2 מקומות עשרוניים בטוח מ-falsy.

**`buildIsraeliStocksExportRows(israeliStocks)`** — לכל מניה: `currentPrice = normalizeIsraeliPrice(stock.currentPrice)`; `totalPurchase = purchasePrice × quantity`; `totalCurrentValue = currentPrice × quantity`. בונה שורה בעברית עם המפתחות: `'שם מנייה'`, `'תאריך קנייה'`, `'מחיר קנייה (₪)'`, `'כמות'`, `'מחיר נוכחי (₪)'` (מעוגל), `'סה"כ רכישה (₪)'` (מעוגל), `'סה"כ שווי נוכחי (₪)'` (מעוגל), `'רווח/הפסד (₪)'` = `totalCurrentValue - totalPurchase` (מעוגל).

**`buildAmericanStocksExportRows(americanStocks)`** — קוראת ל-`calculateAmericanStockMetrics(stock)` (מ-`portfolioMath.js`, לא בקובץ זה) ובונה שורה עם `'מחיר קנייה ($)'`, `'מחיר נוכחי ($)'`, `'שער חליפין נוכחי'` (עדיפות ל-`currentExchangeRate`), `'סה"כ שווי נוכחי ($)'` = `m.totalCurrentValueUSD`, `'סה"כ שווי נוכחי (₪)'` = `m.totalCurrentValueILS`, `'רווח/הפסד ($)'` = `m.profitUSD`, `'רווח/הפסד (₪)'` = `m.profitILS` — כולם מעוגלים.

**`buildPensionFundsExportRows(pensionFunds)`** — `currentValue = fund.currentValue ?? fund.amount ?? 0` (תאימות לאחור). `periodReturn = calculatePensionPeriodReturn(fund)` (מ-`portfolioMath.js`). `'תשואת תקופה (%)'` מוצג רק כשיש `fund.previousValue`, אחרת `''` (מחרוזת ריקה — לא 0 מפוברק).

**`buildCashFundsExportRows(cashFunds)`** — `{'שם קרן', 'מספר נייר', 'תאריך עדכון', 'סכום (₪)' (מעוגל)}`.

**`buildBankBalancesExportRows(bankBalances)`** — `{'תאריך עדכון', 'יתרה (₪)' (מעוגל)}`.

**`buildBankSavingsFundsExportRows(bankSavingsFunds)`** — `totalDeposited = Σ deposits.amount`; `currentValue = computeBankSavingsFundValue(fund)` (ריבית-דריבית מ-`bankSavingsFund.js`). שורה: `'שם'`, `'מסלול השקעה'`, `'ריבית (%)'`, `'צמוד למדד'` (`'כן'/'לא'`), `'סך הפקדות (₪)'`, `'שווי נוכחי (₪)'`, `'רווח/הפסד (₪)'` = `currentValue - totalDeposited` (מעוגל).

**`buildSummaryExportRows(summary)`** — רשימה קומפקטית של הנתונים המרכזיים מ-`calculatePortfolioSummary` (`portfolioSummary.js`, לא בקובץ זה): שם השדות הישיר בלי remapping — `'סה"כ שווי תיק (₪)'`, `'סה"כ השקעה (₪)'`, `'סה"כ רווח/הפסד (₪)'`, `'שינוי יומי משוקלל (%)'`, `'רווח/הפסד יומי (₪)'`, כל אחד מעוגל. `[]` אם `summary` חסר.

---

### `src/utils/exportData.test.js`

בודק: `buildIsraeliStocksExportRows` — חישוב נכון של רכישה/שווי-נוכחי/רווח מ-`currentPrice` כפי שהוא (בהנחה שהוא בשקלים, לא אגורות); רשימה ריקה/חסרה מטופלת בחן. `buildAmericanStocksExportRows` — דוח USD ו-ILS נכון מ-`calculateAmericanStockMetrics` (למשל `190×10=1900$`, `1900×3.7=7030₪`, רווח `(190-150)×10=400$`). `buildPensionFundsExportRows` — תשואת תקופה מחושבת רק כשיש `previousValue` (`11%`), אחרת `''`; fallback ל-`amount` בפורמט legacy. `buildCashFundsExportRows`/`buildBankBalancesExportRows` — עיצוב שורות תקין. `buildSummaryExportRows` — חילוץ headline totals כזוגות מדד/ערך, `[]` לחסר.

---

### `src/utils/exportReport.js`

#### תפקיד

מייצר את הדוחות המורדים (Excel/PDF) של התיק. קוד "דבק" (glue) הקורא לספריות בלבד — עיצוב השורות/מספרים עצמו חי ב-`exportData.js` (טהור ונבדק שם). מחולק לפונקציות "בונות אובייקט מסמך" (`buildPortfolioWorkbook`/`buildPortfolioPdfDoc`, נבדקות באופן עצמאי בלי DOM) לעומת פונקציות "בונה + מפעילה הורדה בדפדפן", כדי שבדיקות יוכלו לתפעל את לוגיקת בניית המסמך האמיתית מבלי לדרוש הורדה אמיתית בדפדפן.

#### מערכות ולוגיקה מפורטת (כולל נוסחאות)

**`todayFileStamp()`** — `new Date().toISOString().slice(0,10)` — תאריך לשם קובץ.

**`addSheetFromRows(workbook, sheetName, rows)`** — אם `rows` ריק, לא מוסיפה גיליון בכלל (לא גיליון ריק). מוסיפה worksheet עם `{views: [{rightToLeft: true}]}` — הגדרת תצוגה בלבד (Excel יציג את הגיליון מימין-לשמאל, לא משפיע על הדאטה בפועל). כותרות = מפתחות האובייקט הראשון; שורת הכותרת מודגשת (`bold`).

**`buildPortfolioWorkbook(data)`** — בונה `ExcelJS.Workbook` עם 7 גיליונות אפשריים לפי הסדר: `'סיכום'`, `'מניות ישראליות'`, `'מניות אמריקאיות'`, `'קופות גמל'`, `'קרנות כספיות'`, `'עוש'`, `'קופות חיסכון בבנק'` — כל אחד מ-`buildXxxExportRows` המתאים מ-`exportData.js`. גיליונות של קטגוריות ריקות מדולגים לגמרי.

**`downloadPortfolioExcel(data)`** — בונה workbook, `xlsx.writeBuffer()`, יוצר `Blob`, `URL.createObjectURL`, יוצר `<a>` זמני עם `download='afikinvest-portfolio-{תאריך}.xlsx'`, מקליק, ומנקה (`revokeObjectURL`).

**`registerHebrewFont(doc)`** — פונטי ה-Latin המובנים של jsPDF (Helvetica וכו') אינם כוללים גליפים עבריים — טקסט עברי רגיל היה מוצג כלטיני-1 מקושקש (מאומת ישירות). פותר על ידי הטבעת `Alef-Regular.ttf` (מקודד base64, רישיון SIL OFL 1.1) — מכיל עברית, לטינית, ספרות, וסימן ₪.

**`toPdfDisplayText(text)`** — פותר בעיה עמוקה יותר: jsPDF וגם `jspdf-autotable` **אין להם תמיכת bidi אמיתית**; `autoTable` בכלל מדלג על טיפול R2L/align מובנה — לתא מיושר-ימין הוא מחשב מיקום X בעצמו וקורא `doc.text(text,x,y)` **בלי אופציות**, כך שמחרוזת עברית גולמית נצבעת בסדר האחסון (התו הראשון שהוקלד מציב שמאלה) — מקוריאה (mirror-reversed) לקורא עברית (מאומת מול PDF אמיתי + בדיקה תו-לתו לפני/אחרי התיקון). אפילו אופציות R2L/isInputRtl של jsPDF עצמו נמצאו כלא מספיקות — הן היפוך גס של כל המחרוזת, לא bidi אמיתי (מאומת: `"2023-01-15"` הפך ל-`"51-10-3202"`). **הפתרון**: הופכים מחרוזות עבריות בעצמנו לפני מסירתן ל-jsPDF, כך ש-LTR רגיל ייצור תוצאה חזותית נכונה — כולל **מראה סוגריים מזווגים** (Unicode Bidi Algorithm rule L4 — `(` ↔ `)`, `[` ↔ `]`) כדי ש-`"(₪)"` לא יהפוך ל-`")₪("`.
- `HEBREW_CHAR_RANGE = /[֐-׿]/` — בדיקה אם המחרוזת מכילה תו עברי כלשהו; אם לא, מוחזרת **ללא שינוי** (תאריכים/טיקרים/מספרים לא נוגעים כלל).
- אלגוריתם: `str.split('').map(ch => BRACKET_MIRRORS[ch] || ch).join('')` (מראה סוגריים) → `.split('').reverse().join('')` (היפוך תווים).
- מוגבל בכוונה: זו לא הטמעת bidi כללית — פועלת נכון כי מחרוזות הייצוא של האפליקציה **אף פעם לא מערבבות** עברית עם ספרות/לטינית מוטבעות באותה מחרוזת (אלה תמיד בתאים/קריאות `text()` נפרדות).

**`addPdfTable(doc, title, rows, startY)`** — אם `rows` ריק, לא מוסיפה טבלה. בודקת אם יש מקום לכותרת+שורה אחת לפני תחתית העמוד (A4 ≈297מ"מ); אם לא — מוסיפה עמוד חדש. מציבה כותרת בעברית (מהופכת דרך `toPdfDisplayText`) בהתאמה ימנית (`align:'right'`). קוראת ל-`autoTable` עם `head`/`body` **שכל תא בהם עובר `toPdfDisplayText`** (אך `headers` הגולמיים משמשים ל-lookup `row[h]`, לא מעוותים). מבטלת בפירוש `fontStyle: 'bold'` שגיליון ברירת המחדל מפעיל לתאי כותרת (כי רק המשקל `'normal'` של Alef רשום — bold היה מחזיר גופן לא-עברי מקושקש).

**`buildPortfolioPdfDoc(data)`** — בונה `jsPDF` ורושם את הפונט העברי. כותב כותרת "AfikInvest" (LTR, בלי היפוך) וכותרת "דוח תיק השקעות" (מהופכת, ישר) ב-**שני** `text()` נפרדים (לא מחרוזת אחת מעורבת — הערה מפורשת שהיפוך שלם לא מטפל בעירוב סקריפטים). בונה 7 טבלאות ברצף: סיכום, מניות ישראליות, מניות אמריקאיות, קופות גמל, קרנות כספיות, עו"ש, קופות חיסכון בבנק — כל טבלה מקדמת את `y`. שים לב: זה דוח **סיכום** (לא dump מלא של כל הדאטה כמו ה-Excel) — PDF מיועד להיות תצוגה מודפסת נוחה, מי שרוצה את כל הדאטה אמור להשתמש בייצוא Excel.

**`downloadPortfolioPdf(data)`** — בונה את המסמך ומורידה עם `doc.save('afikinvest-portfolio-{תאריך}.pdf')`.

---

### `src/utils/exportReport.test.js`

רץ עם `@jest-environment node` (לא jsdom) — כי build ה-node של jsPDF תלוי ב-`fast-png` שדורש `TextEncoder`, קיים ב-Node אך חסר בגרסת jsdom שCRA5 מכניס (אותה בעיה נפתרה באותו אופן ב-`taseScraper.test.js`/`quotesRoutes.test.js`). בודק: `toPdfDisplayText` — מחרוזת בלי עברית נשארת ללא שינוי לגמרי (כולל תאריכים, מספרים, סוגריים `'(100)'`); היפוך תו-לתו למחרוזת עברית טהורה; היפוך גם לביטוי עברי מרובה-מילים (סדר המילים מתהפך יחד עם האותיות — מה ש-RTL דורש); מראה סוגריים מזווגים לפני היפוך (`'מחיר (₪)' → '(₪) ריחמ'`); המרת input לא-string ל-string לפני בדיקת עברית (`null → 'null'`). `buildPortfolioWorkbook` — יוצר גיליון אחד לכל קטגוריה לא-ריקה, בסדר הנכון; מדלג גיליון לגמרי לקטגוריה ריקה (לא גיליון ריק); כותב שורת כותרת ונתונים תקינה; מייצר buffer xlsx אמיתי לא-ריק (מעל 1000 בייט); לא נכשל על נתונים ריקים לחלוטין (מפיק חוברת בלי גיליונות). `buildPortfolioPdfDoc` — מייצר מסמך עמוד יחיד לתיק קטן; buffer PDF אמיתי לא-ריק; לא נכשל על נתונים ריקים; הפונט העברי המוטבע רשום במסמך (`doc.getFontList().Alef` מוגדר).

## חלק 5: קומפוננטות React (UI)

# תיעוד טכני מפורט — קומפוננטות ה-UI של AfikInvest

מסמך זה מכיל פירוט טכני מעמיק, קובץ-קובץ, של כל קבצי ה-UI (React) בפרויקט `afikinvest`. הפרויקט הוא אפליקציית מעקב תיק השקעות (מניות ישראליות/אמריקאיות, קופות גמל, עו"ש, כספיות שקליות, קופות חיסכון בבנק), עם ניתוח תיק, מעקב חודשי, איזון מחדש (rebalancing) ומודול "חקר מניות" בסגנון SimplyWall.st.

---

### `src/App.js`

#### תפקיד
זהו קובץ הרכיב השורש (root component) של כל האפליקציה. הוא לא מרנדר תוכן ישירות אלא פועל כ"מתאם" (orchestrator) מרכזי: הוא מרכז את כל ה-state הגלובלי, את כל ה-hooks (אימות, נתוני תיק, מחירים, מדד CPI, snapshots, יעדי איזון, ערכת נושא), ואת כל הלוגיקה העסקית (handlers), ומעביר אותם כ-props אל ארבעת "המסכים" הראשיים של האפליקציה: מסך התחברות (`AuthView`), מסך הבית עם טבלאות התיק (`HomeView`), מסך טופס הוספה/עריכה (`StockFormView`), מסך ניתוח תיק (`PortfolioAnalysisView`) ומסך חקר מניות (`StockResearchView`). הניווט בין המסכים אינו מבוסס `react-router` אלא על מספר דגלי boolean State (`showForm`, `showAnalysis`, `showStockResearch`) שנשלטים על ידי `TopNav`.

#### לוגיקה ומערכות מפורטות

**קבועים ופונקציות עזר מודולריות (מחוץ לרכיב):**
- `LEGACY_KEYS` — מערך שמות מפתחות ב-`localStorage` מדור קודם (`israeliStocks`, `americanStocks`, `pensionFunds`, `bankBalances`, `cashFunds`) — מהתקופה שלפני שהאפליקציה שמרה תיק בשרת.
- `legacyImportFlagKey(userId)` — בונה מפתח `localStorage` ("afikinvest_legacy_import_done_<userId>") שמסמן שהמשתמש הזה כבר ביצע ייבוא חד-פעמי מהדפדפן לשרת, כדי שלא יוצע לו שוב.
- `readLegacyPortfolioFromLocalStorage()` — קורא את חמשת המערכים מ-`localStorage`, מנרמל את מניות ישראל (`normalizeIsraeliStocksFromStorage`), ומחזיר אובייקט מאוחד (או `null` בשגיאת parsing).
- `portfolioHasAnyRows(p)` — בודק אם לאובייקט תיק כלשהו יש שורות בכל אחד מחמשת המערכים (משמש לדעת אם יש מה לייבא).
- `clearLegacyPortfolioKeys()` — מוחק את כל מפתחות ה-legacy מה-localStorage אחרי ייבוא מוצלח.

**Hooks בשימוש (State מרכזי):**
- `useAuth()` — מחזיר `user`, `authLoading`, `authHeader`, `login`, `logout`.
- `useTheme()` — מחזיר `theme` ('dark'/'light') ו-`toggleTheme`.
- `usePortfolioData(user, authHeader)` — מחזיר את כל שישה המערכים (`israeliStocks`, `americanStocks`, `pensionFunds`, `bankBalances`, `cashFunds`, `bankSavingsFunds`) עם setters, `portfolioReady` (אם הטעינה הראשונית מהשרת הסתיימה), `hasUnsavedChanges`, `saveLoading`, `saveError`, `lastSavedAt`, ופונקציות `savePortfolio`, `replacePortfolio`, `resetPortfolio`.
- `usePriceRefresh({...})` — מרעיש (side-effect) עדכון מחירים תקופתי למניות ישראליות/אמריקאיות; מקבל דגלי `isEditMode`/`editingField`/`isAddingNewStock` כדי לא לדרוס נתונים שבעריכה.
- `useCpiIndex(relevantCpiMonths)` — מושך את מדד המחירים לצרכן (CPI) עבור כל החודשים הרלוונטיים (תאריכי קנייה של מניות + תאריכי הפקדות בקופות גמל/חיסכון), לצורך חישוב מס רווח הון ריאלי מוצמד למדד.
- `usePortfolioSnapshots(user, authHeader)` — ניהול "תמונות מצב" יומיות (snapshot) של שווי התיק: `snapshots`, `snapshotsLoading`, `saveSnapshotNow`, `saving`, `saveError`, `lastSavedAt`.
- `useMonthlySnapshots(user, authHeader)` — ניהול שמירות חודשיות (checkpoint חודשי לצורכי מעקב/השוואה): `monthlySnapshots`, `saveMonthlySnapshot`, `updateMonthlySnapshot`, `deleteMonthlySnapshot`, `addManualMonthlySnapshot` + מצבי loading/error לכל פעולה.
- `useRebalanceTargets(user, authHeader)` — יעדי הקצאת נכסים (%) לצורך תכנון איזון מחדש: `targets`, `loading`, `saving`, `saveError`, `saveTargets`.

**חישובים נגזרים (useMemo):**
- `relevantCpiMonths` — רשימת מפתחות חודש (YYYY-MM) מכל תאריכי הקנייה של מניות ישראליות וכל תאריכי ההפקדות בקופות גמל/חיסכון בבנק (via `monthKeyFromDate`), מסונן מערכים ריקים (`filter(Boolean)`) — מוזן ל-`useCpiIndex`.
- `analysis` — `calculatePortfolioAnalysis(israeliStocks, americanStocks, pensionFunds, cashFunds, bankBalances, bankSavingsFunds)` — חושב פעם אחת (ולא רק כשמסך הניתוח מוצג) כי גם `snapshotBreakdown` (למטה) תלוי בו.
- `snapshotBreakdown` — `buildItemizedMonthlyBreakdown(analysis, pensionFunds, cashFunds, bankBalances, bankSavingsFunds)` — פירוק פריטני (per-holding, לא רק סכום קטגוריה) המשמש גם לשמירת snapshot יומי וגם לשמירה חודשית.
- `summary` — מחושב (לא ב-useMemo, ישירות בגוף הפונקציה) רק כאשר מציגים את מסך הבית: `calculatePortfolioSummary(...)` עם אובייקט CPI (`currentIndex`, `indexByMonth`).

**State מקומי (useState) עיקרי:**
- `showForm`, `showAnalysis`, `showStockResearch` — דגלי ניווט בין מסכים.
- `isAddingNewStock` / `isEditMode` / `editingStock` — מצב טופס הוספה/עריכה.
- `formData` — אובייקט אחיד לכל שדות הטופס (`itemType`, `stockName`, `securityId`, `purchaseDate`, `purchasePrice`, `initialInvestment`, `currentValue`, `previousValue`, `currentValueDate`, `previousValueDate`, `quantity`, `exchange`, `exchangeRate`, `investmentTrack`, `interestRate`, `isLinkedToIndex`).
- `exchangeRateFetching` / `exchangeRateNotFound` — מצב משיכת שער חליפין היסטורי אוטומטית.
- `showAmericanColumns` — האם להציג עמודות "מידע נוסף" בטבלאות (מנוהל בשם מטעה, כי משפיע גם על הטבלה הישראלית והפנסיונית).
- `editingField` — מפתח בפורמט `"<id>-<field>"` שמסמן איזה תא בטבלה נמצא כרגע במצב עריכה inline.
- `expandedGroups` — מיפוי `"<exchange>-<stockName>" -> boolean` לניהול קיבוץ/פתיחה של מניות עם כמה עסקאות (lots).
- `legacyImportCompleted` / `legacyImportLoading` / `legacyImportBanner` — מצב זרימת הייבוא החד-פעמי מ-localStorage.

**Effects:**
- `useEffect` שמאתחל `legacyImportCompleted` לפי `localStorage` בכל שינוי `user`.
- `useEffect` עם `lastAutoFetchKeyRef` — כשה-`itemType==='stock'`, `exchange==='american'` ויש `purchaseDate`, קורא אוטומטית ל-`fillHistoricalExchangeRate` (רק אם התאריך השתנה בפועל, כדי לא למשוך שוב ושוב באותו תאריך).

**Handlers מרכזיים:**
- `handleAddInfo()` — פותח טופס הוספה חדש (מאפס מצב עריכה).
- `handleLogout()` — מתנתק, מאפס את התיק (`resetPortfolio`), חוזר לדף הבית.
- `handleLegacyImportOnce()` — קורא ל-`readLegacyPortfolioFromLocalStorage`, מוודא שיש בו נתונים, מציג `window.confirm` עם אזהרה שהתיק בשרת יוחלף במלואו, שולח `PUT /api/portfolio` ישירות (עוקף את ה-hook), ואז מעדכן state מקומי (`replacePortfolio`), מנקה legacy keys, ומסמן flag ב-localStorage.
- `fillHistoricalExchangeRate(dateStr)` — קורא ל-`fetchHistoricalExchangeRate(dateStr)`; אם התקבל ערך — מעגל ל-4 ספרות עשרוניות (`toFixed(4)`, כדי להתאים ל-`step="0.0001"` בשדה) ומעדכן `formData.exchangeRate`; אחרת מדליק `exchangeRateNotFound`.
- `handleInputChange(e)` — מעדכן שדה גנרי ב-`formData` לפי `name`/`value`.
- `handlePullExchangeRate()` — הפעלה ידנית (כפתור "נסה שוב") של `fillHistoricalExchangeRate`, כגיבוי אם ה-effect האוטומטי לא הצליח.
- `handleSubmit(e)` — **לוגיקת שמירת פריט חדש**, מפוצלת לפי `itemType`:
  - `stock`: מושך מחיר נוכחי חי לפי בורסה — `fetchCurrentPrice` (אמריקאית) או `fetchIsraeliStockPrice` (ישראלית, עם המרה מאגורות לשקלים: `currentPrice / 100`), בונה אובייקט `stockData` עם `id: Date.now()`, ומוסיף למערך המתאים.
  - `cash_fund`: בונה `cashItem` (`fundName`, `securityId`, `updateDate`, `amount`).
  - `pension`: מחפש קופה קיימת עם שם זהה (`trimmedName`) — אם קיימת, מוסיף רשומת הפקדה חדשה למערך `deposits` שלה בלבד (`currentValue`/`previousValue` לא משתנים); אחרת פותח קופה חדשה עם `currentValue` שמתחיל שווה לסכום ההפקדה הראשונה.
  - `bank`: בונה `bankItem` (`updateDate`, `amount`).
  - `bank_savings`: זהה ללוגיקת `pension` (התאמה לפי שם, הצטרפות לפנקס הפקדות קיים או פתיחת קופה חדשה עם `investmentTrack`, `interestRate`, `isLinkedToIndex`).
  - בסיום מאפס `showForm`, `isAddingNewStock` ואת כל `formData`.
- `handleBackToHome()` — סוגר את הטופס.
- `handleNavigate(page)` — נקודת ניווט מרכזית יחידה (מוזנת ל-`TopNav`): מכבה `showForm`, ומדליק את `showAnalysis`/`showStockResearch` בהתאם לערך `page` ('home' מכבה את שניהם).
- `activePage` — נגזר (`showAnalysis ? 'analysis' : showStockResearch ? 'research' : 'home'`) ומוזן ל-`TopNav` לסימון הלינק הפעיל.
- `handleDelete(id, exchange)` — מסיר פריט מהמערך המתאים (switch לפי `exchange`: israeli/american/pension/bank/cash_fund/bank_savings) ומדליק `hasUnsavedChanges`.
- `handleSaveEdit()` / `handleCancelEdit()` — שמירה/ביטול עריכה מלאה של מנייה קיימת (מוודא שדות חובה, מושך מחיר עדכני למניה אמריקאית, מעדכן את המערך המתאים).
- `handleInlineEdit(id, field, value, exchange)` — עדכון שדה בודד inline. עבור `pension` עם `field==='currentValue'`, קורא ל-`applyPensionValueEditPayload(item, value)` (מ-`utils/portfolioMath.js`) — value מגיע כ-`{value, date}` (עדכון ערך+תאריך יחד באותה פעולה), כדי שהערך הישן יעבור אוטומטית ל"שווי קודם" עם התאריך הישן שלו.
- `startInlineEdit` / `finishInlineEdit` / `handleCellClick` / `handleKeyDown` — תשתית העריכה inline: `startInlineEdit` קובע `editingField`, `handleCellClick` מפעיל אותו רק אם `isEditMode`, `handleKeyDown` סוגר עריכה בלחיצת Enter.
- `toggleGroup(stockName, exchange)` — פותח/סוגר קבוצת מניות (מפתח `"<exchange>-<stockName>"`) ב-`expandedGroups`.
- `handleSaveSnapshot()` — שומר snapshot יומי (מוגן ב-`portfolioReady`), עם `analysis.summaryMetrics.overallTotalValueILS` ו-`snapshotBreakdown`.
- `handleSaveMonthlySnapshot(cashFlows)` — מציג `window.confirm` (אזהרה לשמור בתאריך קבוע כל חודש לצורך דיוק ההשוואה), ואז שומר עם `breakdownWithCashFlows` (מיזוג `cashFlows` לאובייקט `snapshotBreakdown`).

**רינדור מותנה (return מוקדם):**
1. אם `authLoading` — מציג הודעת "טוען…".
2. אם `!user` — מציג `AuthView` + כפתור toggle ערכת נושא צף.
3. אם `!portfolioReady` — מציג "טוען את תיק ההשקעות מהשרת…".
4. אם `showForm` — `TopNav` + `StockFormView`.
5. אם `showAnalysis` — `TopNav` + `PortfolioAnalysisView` (עם כל ה-props של snapshots/rebalancing/monthly).
6. אם `showStockResearch` — `TopNav` + `StockResearchView`.
7. ברירת מחדל — `TopNav` + `HomeView` עם כל ה-props (summary, handlers, מצב עריכה, וכו').

---

### `src/App.test.js`

בודק בסיסי בלבד — מדגם ה-Boilerplate המקורי של Create React App (`renders learn react link`) שמצפה לטקסט "learn react". בפועל טסט זה כבר לא רלוונטי לתוכן האמיתי של האפליקציה (שאינה מכילה קישור כזה) ונשאר כשריד היסטורי; לא נמצא בו תוכן שבודק התנהגות ממשית של AfikInvest.

---

### `src/App.css`

#### תפקיד
גיליון ה-CSS הגלובלי הראשי של האפליקציה. מכיל: reset בסיסי, מערכת ערכות נושא (dark/light) מבוססת CSS variables, עיצוב לניווט העליון (`TopNav`), עיצוב לכל מסכי האפליקציה (בית, טופס, ניתוח תיק), עיצוב הטבלאות, ועיצוב מלא ונפרד לעמוד "חקר מניות" (`.sw-page`).

#### לוגיקה ומערכות מפורטות
- **Reset גלובלי** — `* { margin:0; padding:0; box-sizing:border-box }`.
- **מערכת Theme (`:root` variables)**: dark הוא ברירת המחדל (`--sw-bg`, `--sw-surface`, `--sw-accent` (זהב שמפניה) `#d4af6a`, `--sw-accent-2` (טורקיז/אמרלד) `#2dd4bf`, `--sw-green`/`--sw-red`/`--sw-amber` לסמנטיקה). `:root[data-theme='light']` מגדיר סט חלופי בהיר (מוחל דרך attribute על `<html>`, לא class — ראו `useTheme.js`).
- **פס גלילה מותאם** — `scrollbar-width: thin` (Firefox) + `::-webkit-scrollbar` (Chrome/Edge/Safari) בכל האתר.
- **`.top-nav*`** — עיצוב ה-header הדביק (sticky, z-index 30) של `TopNav.js`: מותג עם gradient טקסט, קישורי ניווט עם מחלקת `.active`, אזור פעולות (theme toggle, אימייל משתמש, כפתור התנתקות).
- **`.App` / `.welcome-container` / `.analysis-container`** — מעטפות העמוד המרכזיות; ברוחב מקסימלי 1800px כדי לתת מקום לטבלאות רחבות (הטבלה האמריקאית דורשת `min-width: 1500px`).
- **`.stocks-table` / `.analysis-table`** — עיצוב טבלאות: `thead` עם underline זהוב, `sticky` לעמודה הראשונה (RTL — הראשונה בקצה הימני) עם התאמות רקע נפרדות לכל מצב שורה (hover, detail-row, expanded, dark-mode) כדי שהגלילה מתחת לעמודה הדביקה לא "תבליח".
- **`.editable-cell` / `.editable-row` / `.edit-row`** — עיצוב מצב עריכה inline (input בתוך תא, מסגרת מודגשת בצבע accent).
- **`.btn-warning/.btn-danger/.btn-info/.portfolio-save-btn/.add-info-button`** — משפחת כפתורי הפעולה הראשיים בגרדיאנטים שונים (זהב לפעולה ראשית, כחול לשמירת תיק, אדום למחיקה/יציאה ממצב עריכה).
- **`.auth-*`** — עיצוב מסך ההתחברות/הרשמה (`AuthView`) — כרטיס מרכזי, טאבים (הרשמה/התחברות), שדות RTL עם input בכיוון LTR (למען אימייל/סיסמה).
- **`.pie-chart-container` / `.recharts-*`** — עיצוב תוויות עוגה, הסרת outline מוקדי מיקוד ב-recharts.
- **מדור Dark-mode overrides (`[data-theme='dark'] ...`)** — הערה מפורשת בקוד מסבירה שהעמודים הישנים (Home/Analysis/Form/Auth/הטבלאות) נבנו לפני מערכת ה-theme עם צבעים קשיחים בהיר; לכן מדור זה **מוסיף** שכבת dark מעליהם (במקום לשכתב), בעוד עמוד חקר המניות (`.sw-page`) תוכנן dark-first מההתחלה.
- **`.sw-page` וכל סגנוני `sw-*`** — עיצוב "לוח מחוונים" (dashboard) מודרני, מלא ונפרד, לעמוד חקר מניות: `.sw-sidebar` (תפריט צד sticky עם offset של 76px כדי לא להיחסם ע"י `.top-nav` הדביק), `.sw-card` (כרטיסי תוכן), `.dcf-spectrum-*` (ויזואל "ספקטרום שווי הוגן" בסטייל SimplyWall.st, עם `dir="ltr"` פנימי כדי ש-0% יתאים לקצה שמאל אמיתי), `.sw-treemap-*` (טריפ-מאפ מאזן), `.sw-gauge*` (מדי-עיגול ROE/ROA/ROCE), `.sw-check-*` (סימוני ✓/✗ לבדיקות ה-Snowflake).
- **Media queries** — מספר breakpoints (768px, 700px, 640px, 480px, 800px) להתאמת פריסת רשתות/כפתורים/טבלאות למובייל.

---

### `src/index.js`

#### תפקיד
נקודת הכניסה (entry point) של אפליקציית ה-React. אחראי על "הצמדת" (mount) עץ ה-React ל-DOM האמיתי.

#### לוגיקה ומערכות מפורטות
- מייבא `React`, `ReactDOM` (מ-`react-dom/client`, API של React 18), `index.css`, `App`, ו-`reportWebVitals`.
- קורא ל-`ReactDOM.createRoot(document.getElementById('root'))` ואז `root.render(<App/>)`, עטוף ב-`<React.StrictMode>` (שמפעיל בדיקות/אזהרות נוספות בפיתוח, כגון גילוי side-effects לא טהורים).
- בסיום קורא ל-`reportWebVitals()` בלי callback (כלומר לא שולח בפועל נתוני מדדי ביצועים לשום מקום — התיעוד בקוד עצמו מציין שאפשר להעביר פונקציה כמו `console.log` או endpoint אנליטיקס).

---

### `src/index.css`

#### תפקיד
גיליון CSS גלובלי מינימלי, שריד מ-Create React App, שמגדיר את בסיס הטיפוגרפיה של `body`/`code` לפני שכל שאר הסגנון (`App.css`) נטען.

#### לוגיקה ומערכות מפורטות
- `body { margin:0; font-family: -apple-system, ... , sans-serif }` + anti-aliasing (`-webkit-font-smoothing`, `-moz-osx-font-smoothing`).
- `code { font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace }`.
- לא מכיל שום דבר ספציפי ל-AfikInvest; `App.css` הוא זה שדורס בפועל את רוב הפונט (`Segoe UI` וכו') על `body`.

---

### `src/components/AmericanStocksTable.js`

#### תפקיד
מרנדר את הטבלה "בורסה אמריקאית" במסך הבית — טבלה מלאה של כל אחזקות המניות האמריקאיות, עם קיבוץ אוטומטי לפי שם מניה (כמה "lots"/עסקאות קנייה שונות לאותה מניה מוצגות כשורה מסוכמת אחת, עם אפשרות הרחבה לפירוט per-lot).

#### לוגיקה ומערכות מפורטות
**רכיבי-משנה פנימיים (לא exported):**
- `AmericanEditableFields({stock, ...})` — מרנדר 4 תאי `EditableCell`: `stockName` (טקסט), `purchaseDate` (type="date"), `purchasePrice` (type="number", step 0.01, `parse=parseFloat`), `quantity` (type="number", min 1, `parse=parseInt`). קבלת `nameCellStyle` אופציונלי (padding-left) לשורות detail מוזחות.
- `AmericanSingleStockComputedCells({stock, showAdditionalData, ...})` — מחשב ומרנדר את כל השדות הנגזרים (לא ניתנים לעריכה, חוץ מ-`exchangeRate`):
  - שולף מ-`calculateAmericanStockMetrics(stock)`: `totalPurchaseUSD`, `totalPurchaseILS`, `totalCurrentValueUSD`, `currentExchangeRate`, `totalCurrentValueILS`, `profitUSD`, `profitILS`, `realGainILS`, `currencyExemptGainILS`, `taxILS`, `afterTaxILS`, `exchangeRateImpact`.
  - `profitPercentage = calculateProfitPercentage(purchasePrice, currentPrice)`.
  - עמודות (מוצגות בתנאי `showAdditionalData`): סה"כ רכישה $, סה"כ רכישה ₪* , שער חליפין ביום הקנייה* (EditableCell), שער חליפין היום, מחיר נוכחי, סה"כ שווי $, סה"כ שווי ₪, רווח/הפסד $ ו-₪ (עם `profitClass` לצביעה חיובי/שלילי), אחוז רווח/הפסד, אחוז שינוי יומי (`formatDailyChangePercent`), רווח/הפסד יומי בדולר (`(dailyChangePercent/100) * totalCurrentValueUSD`), השפעת שער חליפין*, מס רווח הון*, רווח לאחר מס*, רווח אינפלציוני*, רווח ריאלי* (* = מוצג רק כש-`showAdditionalData`).
  - כפתור מחיקה (`handleDelete(stock.id, 'american')`) — מוצג רק ב-`isEditMode`.
- `AmericanStocksTable({...})` — הרכיב הראשי, מיוצא כ-default.
  - אם `americanStocks.length === 0` — לא מרנדר כלום (Fragment ריק).
  - כותרת הטבלה (`<thead>`) כוללת 21 עמודות אפשריות (חלקן מותנות `showAdditionalData`/`isEditMode`).
  - **קיבוץ**: `Object.entries(groupStocksByName(americanStocks))` מקבץ לפי `stockName`.
    - אם לקבוצה יש lot יחיד — שורה בודדת (`AmericanEditableFields` + `AmericanSingleStockComputedCells`).
    - אחרת — שורת סיכום מקובצת עם כפתור `expand-button` (▼/▶ לפתיחה/סגירה, מפתח `expandedGroups['american-'+stockName]`, ע"י `toggleGroup`), ומתחתיה (אם `isExpanded`) שורת פירוט (`detail-row`) לכל lot בנפרד.
  - **חישובי סיכום קבוצה (inline, בתוך ה-`.map`)**:
    - `totalPurchaseUSD` / `totalPurchaseILS` / `totalCurrentValueUSD` / `totalCurrentValueILS` — סכימות `reduce` על פני כל ה-lots.
    - `totalCurrentValueILS` משתמש ב-`stock.currentExchangeRate || stock.exchangeRate` כשער — כלומר אם יש שער "היום" מעודכן הוא גובר על שער הקנייה.
    - `averagePurchasePrice`/`averageCurrentPrice` = `total / totalQuantity` (ממוצע משוקלל-כמות).
    - `totalProfitUSD = totalCurrentValueUSD - totalPurchaseUSD`; `totalProfitILS` בהערת קוד מוגדר במפורש כ"רווח נומינלי אמיתי" (לא ריאלי).
    - **מס/רווח ריאלי מסוכמים per-lot** (לא על סכום מצרפי!) — כי לכל lot יש תאריך/שער קנייה שונה. `perLotMetrics = stocks.map(calculateAmericanStockMetrics)`, ואז `totalTaxILS`/`totalRealGainILS` הם `reduce` על פני אלו.
    - `totalAfterTaxILS = totalProfitILS - totalTaxILS`; `totalInflationaryGainILS = totalProfitILS - totalRealGainILS` (רווח אינפלציוני = "מה שנשאר" מהנומינלי אחרי הריאלי).
    - `totalExchangeRateImpact` — סכימת ההשפעה של שינוי שער החליפין על כל lot בנפרד: `stockPurchaseUSD * (currentExchangeRate - purchaseExchangeRate)`.
  - עמודות בשורת הקבוצה שמסומנות "פתח קיבוץ" (כאשר לא מורחב) מציינות שערכן זמין רק לאחר פתיחה (תאריך קנייה, מחיר קנייה, שער חליפין ביום הקנייה).

---

### `src/components/AuthView.js`

#### תפקיד
מסך ההתחברות/הרשמה — מוצג כשאין `user` מחובר (`App.js`, `if (!user)`). זהו המסך הראשון שמשתמש לא-מזוהה רואה.

#### לוגיקה ומערכות מפורטות
- **State**: `mode` ('register'/'login'), `email`, `password`, `loading`, `error`.
- `vercelMissingApiHint()` — פונקציית עזר (מחוץ לרכיב) שבודקת אם ה-hostname מסתיים ב-`vercel.app`/מכיל `vercel` וגם `getApiBase()` ריק — במקרה זה מחזירה הודעת עזר ספציפית ("חסרה כתובת השרת... הוסף REACT_APP_API_URL"), כדי לעזור בפתרון תקלות דיפלוי נפוצות.
- `submit(e)` — ה-handler המרכזי:
  1. `e.preventDefault()`, מנקה `error`.
  2. בונה URL לפי `mode` (`apiUrl('/api/auth/register')` או `/api/auth/login`).
  3. שולח `fetch` POST עם `credentials: 'include'` (עוגיות session) וגוף JSON `{email, password}`.
  4. בודק `content-type` של התגובה — אם היא לא JSON, פרסינג עדין (`.json().catch(() => ({}))`).
  5. אם `!res.ok`: אם `status === 404` וללא JSON — מציג הודעת "לא נמצא שרת API" (שמצטרפת ל-hint של Vercel); אחרת מציג `data.error` או הודעת שגיאה כללית.
  6. אם `data.user` קיים — אם יש `data.token`, שומר אותו (`setAuthToken`), ואז קורא ל-`onAuthenticated(data.user, data.token || '')` (prop שמגיע מ-`App.js`'s `login`).
  7. אם אין `user` בתשובה — הודעת "תגובת שרת לא תקינה".
  8. ב-`catch` (למשל שרת לא זמין) — הודעה על אי-אפשרות התחברות + hint Vercel.
  9. `finally` מכבה `loading`.
- **UI**:
  - טאבים "הרשמה"/"התחברות" (`auth-tab`, מחלקת `active` לפי `mode`) — מחליפים `mode` ומנקים `error`.
  - שדה אימייל (`type="email"`, `required`).
  - שדה סיסמה (`type="password"`) עם `autoComplete` שונה לפי mode (`new-password`/`current-password`), ו-`minLength={8}` **רק** במצב הרשמה (לא בהתחברות — כך שמשתמש קיים עם סיסמה קצרה יותר עדיין יכול להתחבר).
  - הודעת שגיאה (`auth-error`) מוצגת רק אם `error` לא ריק.
  - כפתור submit — טקסט דינמי לפי `loading`/`mode` ("מעבד…" / "צור חשבון" / "התחבר"), `disabled` בזמן `loading`.

---

### `src/components/EditableCell.js`

#### תפקיד
רכיב UI גנרי וניתן לשימוש חזור (reusable) — תא טבלה בודד שמתנהג כ"לחיצה-לעריכה" (click-to-edit). זהו רכיב היסוד שמשמש את `IsraeliStocksTable` ו-`AmericanStocksTable` (במקור היה מקוד כפול ~20 פעמים בשני הקבצים ואוחד לרכיב אחד).

#### לוגיקה ומערכות מפורטות
- **Props**: `id`, `field`, `exchange` (לזיהוי הפריט), `value` (הערך הגולמי לעריכה), `editingField` (המצב הגלובלי — מחרוזת `"<id>-<field>"` שמייצגת איזה תא בעריכה כרגע), `isEditMode`, `handleCellClick`, `handleInlineEdit`, `finishInlineEdit`, `handleKeyDown`, `displayValue` (מה שמוצג כשלא בעריכה — בד"כ מפורמט יותר מ-`value`), `type` (ברירת מחדל `'text'`), `step`, `min`, `parse` (פונקציית טרנספורמציה על ה-raw string מה-input, לדוגמה `parseFloat`), `style`, `className`.
- `isEditing = editingField === \`${id}-${field}\`` — קביעה אם התא הזה ספציפית פתוח לעריכה.
- `cellClassName` — משרשר `editable-cell` (רק אם `isEditMode`) עם `className` חיצוני, ומסנן ריקים.
- `handleChange(e)` — קורא `raw = e.target.value`, מריץ `parse ? parse(raw) : raw`, ומעביר ל-`handleInlineEdit(id, field, parsed, exchange)` — כאן מתבצע ה"פרסינג" (validation/coercion) של הקלט.
- רינדור: `<td onClick={handleCellClick} className={cellClassName} style={style}>` — אם `isEditing`, מרנדר `<input>` (עם `autoFocus`, `onBlur={finishInlineEdit}`, `onKeyDown` שמפעיל `handleKeyDown`, ותכונות `type`/`step`/`min`); אחרת מרנדר את `displayValue`.

---

### `src/components/FinancialAccountsTables.js`

#### תפקיד
מרנדר שלוש/ארבע טבלאות נפרדות במסך הבית: "קופות גמל", "כספית שקלית", "עו"ש" ו-"קופות חיסכון בבנק" — כל אחת מוצגת רק אם יש בה נתונים (`length > 0`).

#### לוגיקה ומערכות מפורטות
**עזרי עריכה כלליים:**
- `formatPercent(value)` — עוטף `NaN`/`null`/`undefined` בהחזרת `'-'`, אחרת `${value.toFixed(2)}%`.
- **State**: `expandedFunds` (מיפוי fund.id → boolean, לפתיחת פירוט הפקדות של קופת גמל), `pensionValueDraft` ({value, date} — טיוטה זמנית לעריכת "שווי נוכחי" עם דיאלוג משולב), `expandedBankSavingsFunds` (אנלוגי לקופות חיסכון בבנק).

**קופות גמל — הלוגיקה המורכבת ביותר בקובץ:**
- `startPensionValueEdit(item)` — מפעיל עריכה משולבת: קובע `pensionValueDraft = {value: item.currentValue ?? item.amount ?? '', date: item.currentValueDate || todayStr}` (תאריך היום כברירת מחדל אם אין תאריך קיים), וקורא `handleCellClick(item.id, 'currentValue', 'pension')`.
- `commitPensionValueEdit(item)` — מוודא `numValue` תקין ו-`date` לא ריק, ואז שולח `handleInlineEdit(item.id, 'currentValue', {value: numValue, date}, 'pension')` — כלומר **ערך ותאריך נשלחים תמיד יחד** (לא בשני שלבים נפרדים), כדי שהעריכה תיתפס כ"עדכון תקופה" אחד ב-`applyPensionValueEditPayload` (ב-App.js).
- `deleteDeposit(fund, depositIndex)` — מסנן הפקדה בודדת מ-`fund.deposits` לפי אינדקס.
- **חישובים inline לכל קופה (בתוך `.map`)**:
  - `initialInvestment = deposits.reduce(sum amounts)` — **נגזר תמיד** מפנקס ההפקדות, לא שדה עצמאי.
  - `profitPercent = ((currentValue/initialInvestment)-1)*100` — "רווח מצטבר מול הפקדות" — מוגדר בהערה כ"מדד עזר בלבד, לא תשואה אמיתית" (מתעלם מתזמון הפקדות).
  - `periodReturn = calculatePensionPeriodReturn(item)` (מ-`utils/portfolioMath.js`) — תשואה מעדכון-לעדכון: מזהה אוטומטית לפי תאריכים אילו הפקדות נפלו בין העדכון הקודם לנוכחי ומנטרל אותן.
  - `updateProfitLoss = currentValue - periodReturn.adjustedPreviousValue` (רק אם `previousValue > 0`) — משתמש ב-`adjustedPreviousValue` ולא ב-`previousValue` הגולמי, כדי שלא תיספר הפקדת-אמצע-תקופה כרווח השקעה (תוקן במפורש כבאג היסטורי בהערת הקוד).
  - `ambiguousPeriod = hasAmbiguousPensionPeriod(item)` — מדליק אזהרה (⚠️ עם `title`) כשתאריך "שווי קודם" זהה לתאריך "שווי נוכחי" (הפקדות שקדמו לתאריך המשותף לא נכללות).
  - אם יש `cpi.currentIndex` — מחשב `realGain`/`inflationaryGain`/`tax`/`afterTaxProfit` דרך `calculatePensionRealGainTax`.
- **עמודות הטבלה**: שם קופה (עם expand-button + עריכת שם inline), סך השקעה ראשונית, "שווי נוכחי" (תא מיוחד עם דיאלוג ערך+תאריך יחד, כולל שני inputs — `number`+`date`, ו-`onBlur` על ה-`<div>` העוטף שמוודא שהפוקוס לא עבר לילד אחר לפני קומיט), תאריך שווי נוכחי, שווי קודם, [תאריך שווי קודם]*, [רווח ריאלי]*, [רווח אינפלציוני]*, [רווח לאחר מס]*, תשואה מעדכון קודם (עם אזהרת ambiguous), רווח מצטבר מול הפקדות (%), סה"כ רווח/הפסד, רווח/הפסד מהשקעה קודמת להיום, [פעולות]* (* = `showAdditionalData`/`isEditMode`).
- שורות פירוט הפקדות (מוצגות אם `isExpanded`): אם אין הפקדות — הודעה עם `colSpan` מחושב דינמית; אחרת שורה לכל הפקדה עם תאריך+סכום וכפתור "מחק הפקדה".

**כספית שקלית ("cash_fund")** — טבלה פשוטה: שם, מספר נייר ערך, תאריך עדכון, סכום — כולם ניתנים לעריכה inline ישירה (ללא רכיב `EditableCell` המשותף — כתוב "manually" כאן, בניגוד לטבלאות המניות).

**עו"ש ("bank")** — טבלה פשוטה עוד יותר: תאריך עדכון + סכום.

**קופות חיסכון בבנק ("bank_savings")**:
- `deleteBankSavingsDeposit` — אנלוגי ל-deposit deletion של קופות גמל.
- חישוב `totalDeposited`, `currentValue = computeBankSavingsFundValue(item)` (מ-`utils/bankSavingsFund.js` — ריבית-דריבית), `profitLoss = currentValue - totalDeposited`.
- מס: `calculateBankSavingsFundTax({deposits, currentValue, isLinkedToIndex, currentIndex, indexByMonth})` — מבחין בין קופה "צמודת מדד" (מס 25% על רווח ריאלי) לבין קופה שאינה צמודה (מס שטוח 15% על נומינלי, נקבע ב-`utils/cpiTax.js`).
- עמודת `isLinkedToIndex` — checkbox, `disabled={!isEditMode}`.
- עמודות: שם, מסלול השקעה, ריבית שנתית, צמוד למדד, סך הפקדות, שווי נוכחי, רווח/הפסד, [מס]*, [רווח אחרי מס]*, [פעולות]*.

---

### `src/components/FinancialAccountsTables.test.js`

בוחן ספציפית את זרימת עריכת "שווי נוכחי" בקופת גמל (Harness פנימי שמדמה בדיוק את wiring האמיתי של `App.js` — `applyPensionValueEditPayload`), כדי לוודא את החוזה מקצה לקצה, לא רק רינדור מבודד. מקרי בדיקה מרכזיים:
- לחיצה על תא "שווי נוכחי" פותחת שני inputs (number+date), עם ה-date מאותחל לתאריך הקיים של הקופה (לא "היום"); שינוי שני הערכים ולחיצת Enter מבצעים קומיט יחיד — הערך/תאריך הישנים "מתגלגלים" ל"שווי קודם" ולא נדרסים.
- קופה בלי `currentValueDate` קיים — שדה התאריך מאותחל לתאריך של היום.
- Blur מהקבוצה (`.pension-value-edit-group`) בלי Enter גם מבצע קומיט (לא רק Enter).

---

### `src/components/HomeView.js`

#### תפקיד
"לוח המחוונים" הראשי (dashboard) של האפליקציה — המסך שמוצג לאחר התחברות כברירת מחדל. מרכיב את: סרגל המשתמש (שמירה, ייבוא legacy), כותרת עמוד + כפתורי ייצוא/הוספה, בנר CPI, `PortfolioSummary`, כפתורי בקרה (מצב עריכה/הצג נוסף/שמור יומי), ושלוש הטבלאות (`IsraeliStocksTable`, `AmericanStocksTable`, `FinancialAccountsTables`).

#### לוגיקה ומערכות מפורטות
- **Props רבים** — מתקבלים כולם מ-`App.js` (state ו-handlers), הרכיב עצמו הוא "טיפש" ברובו (presentation).
- **State מקומי**: `exportError` בלבד (שגיאת ייצוא Excel/PDF).
- `hasAnyData` — `true` אם לפחות אחד מ-6 המערכים לא ריק — שולט אם מוצגים כפתורי הייצוא.
- `exportPortfolioData` — אובייקט מאוחד (`summary` + כל שישה המערכים) שמועבר לפונקציות הייצוא.
- **`handleExportExcel`/`handleExportPdf`** — **דינמי import()** (`await import('../utils/exportReport')`) ולא import סטטי בראש הקובץ! הערת הקוד מסבירה שהחבילה כוללת `exceljs`+`jsPDF`+פונט עברי מוטבע (~458KB gzipped) — טעינה עצלה (lazy) כדי שהמשקל הזה לא יפגע במשתמשים שלא מייצאים.
- **UI-flow לפי סדר**:
  1. `.user-bar` — כפתור ייבוא legacy (מותנה `showLegacyImportButton`), כפתור "שמור שינויים"/"נשמר" (מבוסס `hasUnsavedChanges`+`saveLoading`), חותמת שעת שמירה אחרונה, הודעת שגיאה.
  2. בנר ייבוא (`legacyImportBanner`).
  3. `.page-header-row` — כותרת + כפתורי ייצוא (רק אם `hasAnyData`) + כפתור "+ הוספת מידע חדש" (`handleAddInfo`).
  4. הודעת שגיאת ייצוא (`exportError`).
  5. בנר סטטוס CPI (`cpi.loading`/`cpi.currentIndex`/`cpi.error`) — מסביר את מקור הנתון למס רווח הון ריאלי.
  6. `PortfolioSummary` — רק אם יש מניות ישראליות/אמריקאיות.
  7. `.main-buttons-container` — כפתור toggle מצב עריכה (`btn-danger`/`btn-warning`), כפתור toggle "הצג נתונים נוספים" (`showAmericanColumns`), כפתור "שמור מידע יומי עדכני" (`handleSaveSnapshot`, מבוטל בזמן `snapshotSaving`), שורת סטטוס snapshot (שעת שמירה/שגיאה), הודעת "מצב עריכה פעיל" (מוצגת רק ב-`isEditMode`, עם אנימציית `pulse`/`bounce` מ-`App.css`).
  8. שלוש הטבלאות — מקבלות set אחיד של props: `isEditMode`, `showAdditionalData={showAmericanColumns}`, `expandedGroups`, `editingField`, handlers.
  9. הודעת "אין נתונים" — רק אם `israeliStocks.length===0 && americanStocks.length===0` (לא בודקת את שאר הקטגוריות!).

---

### `src/components/HomeView.test.js`

בוחן את `HomeView` באמצעות פונקציית `makeProps` (עם פיקסטורות של תיק מלא) ו-noop לכל ה-handlers. מקרי בדיקה עיקריים:
- מציג את הסיכום והטבלאות עבור תיק מאוכלס; מציג הודעת "אין נתונים" עבור תיק ריק (וללא `<table>` כלל).
- הסיכום המפורט מוצג תמיד — אין toggle קיפול/הרחבה.
- כפתור "שמור מידע יומי עדכני" חיצוני לכפתור שמירת התיק, יושב באותו `.control-buttons`, קורא ל-`handleSaveSnapshot`, ומשקף מצבי `saving`/`lastSavedAt`/`error`.
- כפתור ייבוא legacy מוצג רק כש-`showLegacyImportButton===true`.
- כפתור השמירה משקף `hasUnsavedChanges`/`saveLoading` ("נשמר" / "שמור שינויים" / "שומר…").
- מוצגת הודעת שגיאת שמירה, ובנר ייבוא legacy.
- כפתורי הייצוא מתקשרים דרך **דינמי import** ל-`downloadPortfolioExcel`/`downloadPortfolioPdf` (הבדיקה משתמשת ב-`waitFor` כי ה-import פותר ב-microtask מאוחר יותר), עם `bankSavingsFunds: []` (ברירת מחדל כשלא הועבר).
- הודעת שגיאה מוצגת אם ה-PDF export נכשל (`throw`).
- כפתורי ייצוא מוסתרים לתיק ריק.
- הודעת "מצב עריכה" מוצגת רק כש-`isEditMode===true`.

---

### `src/components/IsraeliStocksTable.js`

#### תפקיד
מרנדר את הטבלה "בורסה ישראלית" במסך הבית — בדיוק אנלוגי ל-`AmericanStocksTable.js` אך למניות ישראליות (בש"ח בלבד, אין שער חליפין).

#### לוגיקה ומערכות מפורטות
**רכיבי-משנה פנימיים:**
- `IsraeliEditableFields` — 4 שדות ניתנים לעריכה (`stockName`, `purchaseDate`, `purchasePrice` step=0.01, `quantity` min=1) — אותה מבנה בדיוק כמו ב-American, רק בלי `exchange="american"`.
- `IsraeliComputedCells({stock, normalizeIsraeliPrice, ...})`:
  - `displayCurrentPrice = normalizeIsraeliPrice(stock.currentPrice)` — נורמליזציה של מחיר ממקור נתונים ישראלי (אגורות → שקלים, כנראה).
  - `totalPurchase = purchasePrice * quantity`; `totalCurrentValue = displayCurrentPrice * quantity`; `profit = totalCurrentValue - totalPurchase`.
  - **חישוב מס רווח הון ריאלי מוצמד מדד** (inline, לא ב-util חוץ): `indexAtPurchase = cpi.indexByMonth[monthKeyFromDate(stock.purchaseDate)]`, `currentIndex = cpi.currentIndex`. אם שניהם קיימים — `calculateStockRealGainTax({purchasePrice, quantity, currentValue, indexAtPurchase, currentIndex})` מחזיר `tax`/`realGain`; אחרת (fallback) — מס שטוח `profit * TAX_RATE` (רק אם `profit>0`) ו-`realGain = profit` (ללא הצמדה). הערת הקוד מדגישה שזו **בדיוק** אותה לוגיקה כמו ב-`portfolioSummary.js`, לצורך עקביות בין שורת המנייה לסיכום הכולל.
  - `inflationaryGain = profit - realGain` (מה שלא ריאלי, "נשאר" מהנומינלי).
  - `afterTaxProfitILS = profit - capitalGainsTaxILS`.
  - עמודות: סה"כ קנייה, מחיר נוכחי, סה"כ שווי, סה"כ רווח/הפסד, [מדד ביום הקנייה]*, [מדד היום]*, [מס רווח הון]*, [רווח לאחר מס]*, [רווח אינפלציוני]*, [רווח ריאלי]*, אחוז רווח/הפסד, אחוז שינוי יומי, רווח/הפסד יומי בש"ח, [פעולות]*.
- **`IsraeliStocksTable`** — הרכיב הראשי: קיבוץ לפי שם (`groupStocksByName`), lot יחיד → שורה בודדת; מספר lots → שורת סיכום + שורות detail (בדומה ל-American).
  - **הבדל מהותי מהטבלה האמריקאית**: בשורת הסיכום המקובצת, עמודות המדד/מס/רווח-אינפלציוני/רווח-ריאלי (`showAdditionalData`) מחושבות ב-IIFE inline (`(() => {...})()`) בתוך ה-JSX, שמסכם **per-lot** (`stocks.forEach`) בדיוק כמו ב-American — לכל lot יש מדד ותאריך קנייה שונים, אז לא ניתן לחשב על סכום מצרפי בלי הטיה. במקום עמודות "מדד ביום הקנייה"/"מדד היום" (שאינן ניתנות לסיכום), מוצג טקסט "ראה פירוט לכל שורה (מחיצים שונים)" (`colSpan={2}`).

---

### `src/components/PortfolioSummary.js`

#### תפקיד
כרטיס "סיכום התיק" — מוצג מעל הטבלאות במסך הבית (`HomeView`) כשיש למשתמש מניות. מציג שורות/עמודות מסוכמות של כל קטגוריות ההשקעה, בהתבסס לחלוטין על אובייקט `summary` שחושב מבחוץ (ב-`utils/portfolioSummary.js`) — הרכיב עצמו הוא "טיפש" (presentation-only, אין state ואין חישובים משלו).

#### לוגיקה ומערכות מפורטות
- Props: `summary`, `formatPriceWithSign` בלבד.
- **מבנה**: שורה יחידה עליונה ("סה"כ מצב ההון") עם 5 שורות: בורסה ישראלית/אמריקאית (ILS), כספית שקלית, קופת גמל, עו"ש, וסה"כ.
- שורה שנייה: שתי עמודות — "בורסה ישראל - השקעה בש"ח" (סה"כ השקעה/שווי/רווח-הפסד/רווח ריאלי חייב מס/רווח אינפלציוני פטור/מס ששולם/אחוז רווח כללי/אחוז יומי/רווח יומי בש"ח) לצד "בורסה אמריקאית - השקעה בדולר" (מבנה מקביל אך בדולר, עם המרות ל-₪ לשדות מס/רווח ריאלי).
- שורה שלישית: "רווח והפסד כולל (₪)" (רווח נומינלי/ריאלי/אינפלציוני/מס/רווח-לאחר-מס/השפעת דולר, כל התיק המשולב) לצד "קופות גמל - השקעה בש"ח" (הפקדות/שווי/תשואה מעדכון/רווח מצטבר/רווח-הפסד/רווח ריאלי/אינפלציוני).
- **צביעה דינמית**: כל ערך רווח/הפסד מקבל class `profit-positive`/`profit-negative` בהתאם לסימן שלו (`value >= 0 ? 'profit-positive' : 'profit-negative'`), ומספרי מס מוצגים תמיד עם מינוס וב-class `profit-negative` קשיח.
- כל השדות מגיעים ישירות מ-`summary.<field>` — אין שום חשבון בקובץ הזה עצמו.

---

### `src/components/RebalancingSection.js`

#### תפקיד
תת-סקציה בתוך `PortfolioAnalysisView` (סקציית "איזון מחדש / Rebalancing") — מאפשרת למשתמש להגדיר יעדי הקצאה (%) לכל קטגוריית נכסים, ומציגה תוכנית פעולה (לקנות/למכור) כדי להתאים את התיק בפועל ליעדים.

#### לוגיקה ומערכות מפורטות
- Props: `exchangeDistribution` (הפילוג הנוכחי בפועל), `formatPriceWithSign`, `targets`/`targetsLoading` (יעדים שמורים מהשרת), `saving`/`saveError`, `onSaveTargets`.
- **State מקומי**: `draft` (טיוטת יעדים בעריכה, מאותחלת ל-`emptyTargets()`), `savedMessage` (הודעת "היעדים נשמרו" זמנית).
- `useEffect` על `targets` בלבד (**לא** על כל re-render) — מאתחל `draft` כשה-targets נטענים מהשרת; ההערה בקוד מדגישה שהוא לא מגיב לכל render כדי לא לדרוס עריכה שהמשתמש באמצע.
- `handleChange(key, rawValue)` — מנקה `savedMessage`, ממיר `rawValue` ל-`Number` (או `''` אם ריק) ועדכן ב-`draft`.
- `handleSave()` — אסינכרוני: קורא ל-`onSaveTargets(draft)`; אם הצליח (`ok`), מציג "היעדים נשמרו" ומנקה אותו לאחר 3 שניות (`setTimeout`).
- אם `targetsLoading` — מציג הודעת טעינה בלבד ומחזיר מוקדם (early return).
- **חישובים**: `sum = sumTargetPercents(draft)`, `valid = isValidTargetAllocation(draft)` (בד"כ בודק שהסכום = 100%), `plan = computeRebalancingPlan(exchangeDistribution, draft)` — כולם utils חוץ.
- **UI**:
  - `.rebalance-inputs-grid` — input `number` (0–100, step 1) לכל קטגוריה (`REBALANCE_CATEGORIES`) עם `CATEGORY_LABELS_HE` לתווית.
  - שורת סכום: מציגה `sum.toFixed(1)%` בצבע ירוק/אדום לפי `valid`; אם לא valid — hint "(צריך להסתכם ב-100%)"; כפתור "שמור יעדים" (`disabled={saving || !valid}`); הודעת הצלחה/שגיאה.
  - אם `!valid` — הודעה שיש להזין יעדים שמסתכמים ל-100%.
  - אם `plan.totalValueILS <= 0` — הודעת "אין עדיין שווי תיק לחשב לפיו איזון".
  - אחרת — טבלה עם עמודות: קטגוריה, % נוכחי, % יעד, סטייה (diffPercent, מסומן +/- וצבוע), פעולה מוצעת — אם `Math.abs(diffValue) < 1` מוצג "מאוזן", אחרת "לקנות"/"למכור" + סכום מוחלט (₪).

---

### `src/components/StockFormView.js`

#### תפקיד
מסך הטופס לצורך הוספה או עריכה של פריט בתיק — מנייה, קופת גמל, עו"ש, כספית שקלית, או קופת חיסכון בבנק. זהו רכיב "טיפש" לחלוטין (כל state/handlers מגיעים כ-props מ-`App.js`).

#### לוגיקה ומערכות מפורטות
- Props: `isEditMode`, `formData`, `handleSubmit`, `handleInputChange`, `handleBackToHome`, `handleSaveEdit`, `handleCancelEdit`, `exchangeRateFetching`, `exchangeRateNotFound`, `onPullExchangeRate`.
- כותרת דינמית: "עריכת מנייה" / "הוספת מידע על מנייה" (לפי `isEditMode`).
- **שדה "מה להוסיף"** (`<select name="itemType">`) — קובע איזה שדות רלוונטיים מוצגים: מנייה / קופת גמל / עו"ש / כספית שקלית / קופת חיסכון בבנק.
- **רינדור מותנה מדורג** (chain ארוך של `formData.itemType === 'X' && (...)`):
  - `stock`: שדה "ID מנייה מ-TASE" (אם `exchange==='israeli'`) או "שם מנייה" (אמריקאית), עם placeholder שונה ו-hint לישראלית.
  - `pension`: שדה "שם קופה" + הערה שהצטרפות לקופה קיימת (אותו שם מדויק) אוטומטית.
  - `cash_fund`: שדה "מספר נייר ערך".
  - `bank_savings`: שדה "שם קופת חיסכון" + הערה דומה לקופת גמל.
  - שדה תאריך משתנה תווית לפי סוג ("תאריך קנייה" / "תאריך ההפקדה" / "תאריך עדכון") — מוצג לכל 5 סוגי הפריטים.
  - שדה סכום — `purchasePrice` למניה/עו"ש/כספית שקלית, `initialInvestment` לקופת גמל/חיסכון.
  - `bank_savings` בלבד: שדות נוספים `investmentTrack` (מסלול השקעה, טקסט חופשי), `interestRate` (ריבית שנתית %, עם הערה שהשווי מחושב אוטומטית בריבית-דריבית), ו-checkbox `isLinkedToIndex` (עם `onChange` מיוחד שעוטף את הערך ב-`{target: {name, value: checked}}` כדי להתאים לחתימת `handleInputChange` הגנרית) — עם הערת מס (25% על ריאלי אם צמוד, 15% שטוח אם לא).
  - `stock` בלבד: `quantity` (min 1), `exchange` (select ישראלי/אמריקאי).
  - **שער חליפין אוטומטי** (רק `stock`+`exchange==='american'`): רינדור מותנה מדורג:
    - אין `purchaseDate` — הודעה "יש לבחור תחילה תאריך קנייה".
    - `exchangeRateNotFound` — אזהרה + כפתור "נסה שוב" (`onPullExchangeRate`) + input ידני (step 0.0001).
    - `exchangeRateFetching || !exchangeRate` — הודעת "שולף את שער הדולר-שקל...".
    - אחרת — מציג את השער שנמשך אוטומטית (`formData.exchangeRate`).
  - כפתורי טופס: "חזרה לדף הבית" (תמיד), ואז אם `isEditMode` — "שמור שינויים" + "ביטול" (שני כפתורים `type="button"`, לא submit של הטופס), אחרת כפתור `type="submit"` יחיד "שמור מידע".
- **אין validation מקומי מלבד HTML native** — `required`, `min`, `step`, `minLength` על שדות ה-`<input>`; הלוגיקה של validation עסקית (למשל בדיקת שדות חובה בעריכה) נמצאת ב-`App.js`'s `handleSaveEdit`.

---

### `src/components/StockResearchView.js`

#### תפקיד
עמוד "חקר מניות" — עמוד עצמאי, לא תלוי תיק ההשקעות של המשתמש, המאפשר חיפוש כל מניה וקבלת ניתוח מקיף בסגנון SimplyWall.st "Snowflake" (ציוני בדיקה לפי 6 קטגוריות), עם ערכת נושא כהה עמוקה משלו (`.sw-page`, נפרדת משאר האתר).

#### לוגיקה ומערכות מפורטות
**קבועים מודולריים:**
- `TREND_LABELS_HE` — מיפוי מפתחות מגמת אנליסטים (strongBuy...strongSell) לעברית.
- `CATEGORY_QUESTIONS_HE` — שאלה בעברית לכל קטגוריית ניקוד (value/futureGrowth/pastPerformance/financialHealth/dividend/ownership).
- `VERDICT_SUMMARY_HE` — משפט תקציר ל-BUY/HOLD/SELL.
- `formatUsdCompact(value)` — פורמט מספרים כספיים גדולים (`$47.94B`/`$1.23M`/`$5.0K`/`$1.23`) לפי סף גודל.
- `SW_DARK`/`SW_LIGHT` — שני סטים מלאים של צבעים הקסדצימליים (לא CSS variables!) — הערת קוד מסבירה ש-recharts דורש ערכי SVG ליטרליים, ולכן יש להחזיק שני סטים במקביל ל-`:root`/`:root[data-theme='light']` שב-`App.css`, ולבחור מהם דינמית לפי ה-`theme` prop.
- `LtrChart({children, height})` — עוטף גרף recharts ב-`<div dir="ltr">` — נחוץ כי recharts מניח פריסת LTR ומתבלבל בתוך קונטיינר RTL (תוויות עמודות קטגוריה נחתכות אחרת).
- `makeTreemapCellRenderer(strokeColor)` — פונקציה שמייצרת רנדרר custom ל-treemap: מטפלת בשני תיקונים ספציפיים — (1) חיתוך טקסט ל-`clipPath` פר-תא כדי שתווית ארוכה לא "תשפוך" לתא שכן; (2) הצגת שם/ערך רק אם יש מקום משוער (הערכת רוחב תווים בעברית מודגשת, ~7.5px/תו בגודל 11, ~6px/תו בגודל 10) — לא לפי סף פיקסלים גס.
- `collectRewardsAndRisks(categories, limit)` — עובר על כל קטגוריות הניקוד, אוסף כל בדיקה עם `passed===true` ל-`rewards` ו-`passed===false` ל-`risks`, וחותך לגבול (`limit`, בשימוש = 5).

**Hooks בשימוש:** `useStockSearch(query)` (חיפוש/autocomplete), `useStockResearch(selectedSymbol)` (נתוני המניה עצמה), `useDividendData`, `useStockNews`, `useAnalystRecommendations` — כולם מוגבלים ל-`searchSymbols` (מערך בגודל 0/1, המניה הנבחרת בלבד).

**State**: `query`, `showSuggestions`, `selectedSymbol`, `selectedName`, `dcfChartPeriod` ('7D'/'1Y').

**חישובים נגזרים (useMemo) עיקריים:**
- `newsFeed = buildNewsFeed(newsBySymbol, 8)`.
- `analystUpside`/`analystSentiment` — נגזרים מ-`rec` (recommendationsBySymbol[selectedSymbol]).
- `scorecard = buildStockScorecard(research, dividendsBySymbol[selectedSymbol])` — הליבה: אובייקט הבדיקות/הקטגוריות/הפסק.
- `categoryEntries`, `radarData` (למפת רדאר: `{category, percent}` לכל קטגוריה, `categoryPercent(cat) ?? 0`).
- `{rewards, risks} = collectRewardsAndRisks(scorecard.categories, 5)`.
- **Phase 2 — ויזואליזציות עומק פיננסי** (כל אחת null/[] אם אין נתונים, לא ערך מפוברק):
  - `dcfResult = computeDcfFairValue(research, research.fundamentalsHistory)`.
  - `dcfSpectrumLayout = computeValuationSpectrumLayout(fairValuePerShare, currentPrice)` — פוזיציות % למרקרים על "ספקטרום השווי" (dir LTR).
  - `dcfFairValueHistory = computeDcfFairValueHistory(...)`.
  - `dcfChartData` — ממזג `mergeFairValueIntoPriceHistory(priceHistory, dcfFairValueHistory)` ומסנן לפי חלון (`dcfChartPeriod` — 7 או 365 יום, `cutoff` מחושב מ-`Date.now()`).
  - `dcfChartPriceChangePercent` — אחוז שינוי מחיר בין ראשון לאחרון בחלון המסונן (רק אם ≥2 נקודות עם `close`).
  - `revenueBreakdown`/`revenueTrend`/`balanceSheetTreemap` — נבנים מ-`research.fundamentalsHistory`.
  - `treemapDataWithColors` — מוסיף `fill` per-leaf (צבע UI, לא לוגיקה עסקית) — תלוי גם ב-`theme` (eslint-disable exhaustive-deps כי `TREEMAP_COLORS` תלוי ב-theme אבל לא deps רשמי).
  - `latestRoce = computeLatestRoce(...)`, `historicalPe = buildHistoricalPeSeries(annualDilutedEPS, priceHistory)`.
  - `dividendMarkers` — עבור כל תשלום דיבידנד בהיסטוריה, מוצא נקודת מחיר קרובה (`findNearestPricePoint`), מסנן כפילויות (`seen` Set), למרקרים על גרף המחיר.
- `handleSelectSymbol(symbol, name)` — קובע מנייה נבחרת, מנקה חיפוש, ומאפס `sectionRefs.current = {}` (כדי שהניווט הצידי יעבוד נכון על העמוד החדש).
- `scrollToSection(key)` — כמו בעמוד ניתוח התיק.
- `peerPeChartData` — משדך `similarCompanies` (מ-Yahoo) עם `research.peerQuotes` לפי סימבול, ומכניס בראש את המניה הנבחרת עצמה (`isSelected: true`) אם יש לה `trailingPE` תקין.
- `renderGauge(label, rawFraction, color)` — פונקציה מקומית (לא useMemo) שמציגה מד-עיגול (RadialBarChart): מחשב `percent = rawFraction*100`, `clamped` ל-0–100 (רק לצורך קשת התצוגה — המספר המוצג עצמו לא נקטע, כי חברה יכולה לדווח ROE מעל 100% מבייבק).

**UI — מבנה:**
1. תיבת חיפוש (`.sw-search-box`) עם autocomplete (`.sw-search-suggestions`), `onBlur` שסוגר את הרשימה רק אם הפוקוס עזב את הקונטיינר.
2. State ריק ("חפשו מניה למעלה") / טעינה / שגיאה / — לפני בחירת מניה.
3. פריסת `sw-layout` (סיידבר + main) עם `navItems` דינמי (כולל קטגוריות הניקוד בפועל).
4. כרטיס overview: תקציר חברה, REWARDS/RISK ANALYSIS bullet lists, RadarChart של הציונים, כיתוב "Snowflake Analysis" עם משפט verdict.
5. כרטיס היסטוריית מחיר (AreaChart + מרקרי דיבידנד).
6. כרטיס תמצית פיננסית (PieChart הרכב הכנסות + BarChart מגמת הכנסות/רווח).
7. **סקציות ממוספרות** לכל קטגוריית ניקוד — badge-row עם עיגולי ✓/✗/— לכל בדיקה, רשימת בדיקות מפורטת (`sw-checks-list`), ותוספות ספציפיות: קטגוריית `value` מקבלת גרפי P/E-מול-עמיתים, P/E היסטורי, וה-DCF spectrum widget המורכב (calloutים ל-Current Price/Fair Value, connector lines, 3 אזורי צבע לפי `underZoneBoundaryPosition`/`overZoneBoundaryPosition`, תוויות זונה עם anti-overlap logic, אזהרת low-confidence, וגרף "Future Cash Flow Value History" עם toggle 7D/1Y); קטגוריית `financialHealth` מקבלת שני treemaps (נכסים / התחייבויות+הון) כל אחד עם legend נפרד, ושלושת מדי ה-gauge (ROE/ROA/ROCE); קטגוריית `ownership` מקבלת טבלת עסקאות פנימיים.
8. כרטיס המלצות אנליסטים (מיני-כרטיסים: המלצה מוסכמת, יעד ממוצע, טווח יעדים; פילוח מגמה נוכחית; היסטוריית שדרוגים/הורדות).
9. כרטיס הנהלה+אודות (עובדים, מיקום, אתר, טבלת הנהלה בכירה).
10. כרטיס חברות דומות — כל אחת כ-chip לחיץ שקורא ל-`handleSelectSymbol` (מעביר לניתוח שלה).
11. כרטיס חדשות אחרונות.

---

### `src/components/StockResearchView.test.js`

בוחן את `StockResearchView` עם כל ה-hooks ממוקים (`jest.mock`). מכיל פיקסטורת `goodResearch` (עוברת את כל 14 הבדיקות — verdict BUY). מקרי בדיקה מרכזיים:
- מצב ריק לפני חיפוש; autocomplete מציג הצעות; בחירה טוענת מנייה.
- verdict BUY (REWARDS מוצג, RISK ANALYSIS לא) לעומת verdict SELL (RISK ANALYSIS מוצג, בדיקות נכשלות > 0) לפי נתוני fundamentals.
- הודעת שגיאת טעינה מוצגת במקום הניקוד.
- כפתור חזרה קורא ל-`onBack`; קליק על פריט סיידבר מגלגל (`scrollIntoView`) לסקציה.
- אנליסטים: המלצה, מס' אנליסטים, יעד מחיר + % עלייה, טווח יעדים, פילוח מגמה (מסתיר שורות עם ערך 0), היסטוריית שדרוגים.
- הודעת "אין נתוני אנליסטים" כשאין coverage.
- אודות חברה/הנהלה/חברות דומות — כולל בחירת peer עם שם ריק (מציג טיקר בלבד, לא כפול).
- הודעות "אין נתונים" נפרדות להיסטוריית מחיר, תמצית פיננסית, DCF, עסקאות פנימיים — וכולן נעלמות כשיש נתונים עשירים (`richResearch`), עם בדיקות מפורטות על ה-DCF spectrum (Over/Undervalued, האזורים הקבועים 20%), הטריפמאפ (2 קבוצות, legend מלא לכל item למרות גודל תא), ומדי ה-gauge (ROE/ROA/ROCE מדויקים).
- אזהרת "low confidence" ב-DCF מוצגת רק כשה-FCF ההיסטורי כולל שנה שלילית/אפסית, לא בעסק "יציב".
- גרף "Future Cash Flow Value History" מוצג רק אם יש היסטוריית מחיר טרייה בחלון הנבחר, עם toggle 7D/1Y תקין ותג שינוי % ודיסקליימר.
- רינדור תקין גם ב-`theme="light"` (מוכיח שהקומפוננטה בפועל בוחרת צבעים ליטרליים לפי ה-prop, לא רק CSS).

---

### `src/components/StockTables.test.js`

בוחן במשולב את `IsraeliStocksTable` ו-`AmericanStocksTable` (שתיהן, בקובץ אחד). לכל אחת:
- רינדור שורות בודדות/מקובצות במצב תצוגה.
- מצב `editingField` פותח input בתא הנכון (`type="text"`/`type="number"` בהתאמה, כולל `exchangeRate` הספציפי לאמריקאיות).
- הרחבת קבוצה (`expandedGroups`) מציגה מספר נכון של `.detail-row` (2 עבור ICL/MSFT עם 2 lots) ומספיק כפתורי מחיקה במצב עריכה.
- `showAdditionalData=false` מקטין את מספר העמודות (`th`) בהשוואה ל-`true` (בטבלה האמריקאית).
- רשימת מניות ריקה → אין `<table>` ברינדור בכלל (Fragment ריק).

---

### `src/components/ThemeToggleButton.js`

#### תפקיד
כפתור עגול קטן ועצמאי להחלפת ערכת נושא (בהיר/כהה) — משמש בשני מקומות: בתוך `TopNav` (למשתמש מחובר) ובעצמאות מוחלטת ב-`AuthView`/מסך ההתחברות (`App.js`'s `.auth-theme-toggle-wrap`, שאין בו `TopNav` מלא כי אין עדיין דפי ניווט).

#### לוגיקה ומערכות מפורטות
- Props: `theme`, `onToggleTheme`.
- `isDark = theme === 'dark'`.
- מרנדר `<button>` יחיד עם `aria-label`/`title` נגישים ("עבור למצב בהיר"/"עבור למצב כהה", לפי המצב **ההפוך** ממה שמוצג — כי הטקסט מתאר את הפעולה שהלחיצה תבצע), ואיקון אמוג'י (`☀️` במצב כהה — "לחץ למעבר לבהיר"; `🌙` במצב בהיר).
- אין state עצמי — כל ההיגיון (מה theme, איך משנים אותו) חי ב-`useTheme()` hook ב-`App.js`.

---

### `src/components/TopNav.js`

#### תפקיד
כותרת ניווט עליונה (header) קבועה ודביקה (sticky), המוצגת בכל דף אחרי התחברות (בית/ניתוח תיק/חקר מניות). מחליף את התבנית הישנה שבה כל דף ניהל בעצמו כפתור "חזרה" נפרד (כפתורי "חזרה" הישנים נשארו כדרך שנייה חזרה, ראו הערת קוד — לא הוסרו מתוך שיקולי סיכון).

#### לוגיקה ומערכות מפורטות
- קבוע מודולרי `NAV_ITEMS` — 3 פריטי ניווט: `home` ("בית"), `analysis` ("ניתוח תיק"), `research` ("חקר מניות").
- Props: `activePage`, `onNavigate`, `user`, `onLogout`, `theme`, `onToggleTheme`.
- מבנה: `<header className="top-nav">` > `.top-nav-inner` המכיל: `.top-nav-brand` ("AfikInvest"), `<nav className="top-nav-links">` — כפתור לכל `NAV_ITEMS` עם `className` דינמי (`active` כש-`activePage === item.key`) שקורא ל-`onNavigate(item.key)`, ו-`.top-nav-actions` — `ThemeToggleButton`, ואם `user` קיים: אימייל המשתמש + כפתור "התנתקות" (`onLogout`).
- אין state עצמי — רכיב "טיפש" גרידא.

---

### `src/components/TopNav.test.js`

בודק:
- שלושת קישורי הניווט מוצגים, והפעיל (`activePage`) מסומן ב-class `active` (בדיוק אחד).
- קליק על קישור קורא ל-`onNavigate` עם המפתח הנכון ('analysis'/'research'/'home').
- אימייל המשתמש מוצג וכפתור התנתקות קורא ל-`onLogout`.
- ללא `user` — לא מוצגים אימייל/כפתור התנתקות.
- כפתור ה-theme toggle משקף את ה-theme הנוכחי (טקסט aria-label הפוך) וקורא ל-`onToggleTheme`.

---

### `src/reportWebVitals.js`

#### תפקיד
פונקציית עזר סטנדרטית (שריד Create React App) למדידת מדדי ביצועים בדפדפן (Web Vitals). נקראת מ-`index.js` בסוף תהליך ה-mount.

#### לוגיקה ומערכות מפורטות
- מייצאת פונקציה `reportWebVitals(onPerfEntry)`.
- אם `onPerfEntry` הועבר והוא מסוג `Function` — מבצעת דינמי `import('web-vitals')` (code-splitting, לא נטען אלא אם צריך), ולאחר שנטען קוראת ל-5 הפונקציות: `getCLS`, `getFID`, `getFCP`, `getLCP`, `getTTFB`, כל אחת עם `onPerfEntry` כ-callback.
- ב-`index.js` נקראת ללא פרמטר (`reportWebVitals()`) — כלומר בפועל לא עושה כלום כרגע (אין callback שיופעל).

---

### `src/logo.svg`

#### תפקיד
קובץ SVG לוגו React (הריאקטור התלת-כנפי הכחול-טורקיז) — שריד ברירת המחדל של Create React App. לא נראה בשימוש בקוד ה-UI בפועל (App.js/index.js הנוכחיים אינם מייבאים אותו) — קובץ יתום מה-boilerplate המקורי.

#### לוגיקה ומערכות מפורטות
- SVG סטטי טהור, `viewBox="0 0 841.9 595.3"`, `fill="#61DAFB"` — נתיב יחיד (path) מורכב שמצייר את שלושת האליפסות המצטלבות + עיגול מרכזי (`<circle>`) שמרכיבים את סמל React. אין בו שום לוגיקה — קובץ נכס גרפי בלבד.

---

### `src/setupTests.js`

#### תפקיד
קובץ הגדרות גלובלי לסביבת הבדיקות (Jest, נטען אוטומטית לפני כל קובץ טסט לפי תצורת Create React App). מוסיף מאצ'רים ופוליפילים חסרים שנחוצים כדי שרכיבים מסוימים יעבדו בסביבת jsdom.

#### לוגיקה ומערכות מפורטות
- מייבא `@testing-library/jest-dom` — מוסיף מאצ'רים כמו `toHaveTextContent`.
- **פוליפיל `TextEncoder`/`TextDecoder`** — `global.TextEncoder = require('util').TextEncoder`, `global.TextDecoder = require('util').TextDecoder`. הערת הקוד מסבירה: גרסת jsdom שמגיעה עם CRA5 לא מספקת אותם, אבל שרשרת התלויות של `jsPDF` (`fast-png` → `iobuffer`) מפנה אליהם בזמן import — כל טסט שמרנדר קומפוננטה שמייבאת (אפילו בעקיפין, כמו `HomeView.js`) את `exportReport.js` היה נכשל אחרת עם "TextEncoder is not defined" עוד לפני הרצת גוף הטסט.
- **Stub ל-`ResizeObserver`** — jsdom לא מיישם אותו, אבל `recharts`' `ResponsiveContainer` דורש אותו למדידת הקונטיינר. מוגדר כ-class עם 3 מתודות ריקות (`observe`/`unobserve`/`disconnect`) — מספיק כי אין ל-jsdom מנוע layout אמיתי בכל מקרה, אז אין תלות אמיתית בהתנהגות resize בפועל בטסטים.

---

### `src/assets/fonts/Alef-OFL.txt`

#### תפקיד
קובץ רישיון (לא קוד) — טקסט מלא של **SIL Open Font License גרסה 1.1** לפונט העברי "Alef" (מאת HaGilda ו-Mushon Zer-Aviv, © 2012). מלווה את שיבוץ הפונט לצורך ייצוא PDF (ראו `alefRegularBase64.js` ו-`utils/exportReport.js`).

#### לוגיקה ומערכות מפורטות
- אין בו קוד; מדובר בטקסט משפטי סטנדרטי (הגדרות, תנאי רישוי, איסור מכירה בנפרד, שימור שם הפונט השמור, פטור אחריות). קיומו בפרויקט הוא תנאי הרישוי עצמו — ה-OFL מתיר שיבוץ בתוכנה בתנאי ששמורה הודעת הזכויות והרישיון (סעיף 2), ולכן הקובץ נלווה חובה לכל שיבוץ של הפונט (במקרה הזה, בתור base64 בתוך קוד ה-JS).

---

### `src/assets/fonts/alefRegularBase64.js`

#### תפקיד
מודול JavaScript שמכיל את קובץ הפונט `Alef-Regular.ttf` המקודד כ-**Base64** כמחרוזת ענקית (קובץ בגודל עצום — כ-116K טוקנים בבדיקת קריאה, כלומר מאות אלפי תווים). משמש להטמעת פונט עברי בתוך PDF-ים שהאפליקציה מייצאת (`utils/exportReport.js`).

#### לוגיקה ומערכות מפורטות
- שתי שורות הערה בראש הקובץ מסבירות את הצורך: דפדפנים לא יכולים לטעון קבצי TTF מהדיסק בזמן ריצה בדרך ש-`jsPDF` דורש — לכן הפונט מוטבע כ-Base64 ישירות בקוד המוגש (bundle), ו-`jsPDF` יכול לרשום אותו כפונט מותאם ולהשתמש בו כדי לרנדר טקסט עברי תקין בתוך ה-PDF המיוצא (אחרת PDF שנוצר ב-jsPDF לא יודע לצייר עברית כברירת מחדל).
- מצוין שהרישיון (SIL OFL 1.1, ראו הקובץ הקודם) "מתיר במפורש שיבוץ/צירוף בתוך תוכנה" — הצדקה משפטית מפורשת לגישה הזו.
- מבחינה טכנית: כל הקובץ הוא בעצם ייצוא של קבוע מחרוזת אחת (Base64) — לא נמצאה בו לוגיקה מעבר לכך (זוהתה רק שורת `export` אחת ארוכה ביותר בגריפ), ולכן לא נקרא בשלמותו; תפקידו התפקודי (data blob) ברור מהקשר השימוש שלו ומההערות בראשו.

## חלק 6: React Hooks

# תיעוד טכני מפורט — Hooks וקבצי קונפיגורציה בפרויקט afikinvest

מסמך זה מתעד לעומק את כל ה-React Hooks של שכבת ה-data fetching בפרויקט, ואת קבצי התצורה, ה-CI/CD, וה-build הראשיים.

---

### `src/hooks/useAnalystRecommendations.js`

**תפקיד**

ה-hook הזה מביא נתוני "המלצות אנליסטים" (buy/hold/sell, מחיר מטרה וכו') עבור רשימת טיקרים אמריקאיים, בבקשה מרוכזת אחת לשרת. הוא נתמך על ידי `server/analystRoutes.js` — נתונים פומביים (ללא צורך באימות משתמש), ומשמש להצגת המלצות אנליסטים לצד המניות בתיק. המבנה שלו זהה במתכוון ל-`useStockSectors.js` (ראו הערת המפתח בתחילת הקובץ).

**לוגיקה מפורטת**

- מקבל פרמטר `symbols` (מערך טיקרים גולמי).
- מנרמל: הופך למחרוזות, `trim`, `toUpperCase`, מסנן ריקים, ומסיר כפילויות (`uniqueSymbols`).
- שומר ב-`useRef` (`knownSymbolsRef`, אובייקט `Set`) אילו טיקרים כבר נבקשו בעבר בהצלחה — כך שאם הרשימה מתעדכנת (למשל טיקר חדש נוסף לתיק) הבקשה החדשה תכיל רק את הטיקרים ה"חדשים" (`missingSymbols`), ולא תבקש שוב מידע שכבר יש.
- בונה `missingKey` — מחרוזת ממוינת ומחוברת בפסיקים של `missingSymbols` — שמשמשת כתלות (dependency) יחידה של ה-`useEffect`, במקום להסתמך על ה-reference של מערך ה-props (שמשתנה כל רנדר) — כך נמנעת לולאת fetch על כל רנדר.
- אם אין טיקרים חדשים — לא מתבצעת קריאה בכלל.
- אחרת: קורא `POST /api/analyst-recommendations` עם body `{ symbols: missingSymbols }`.
- בהצלחה: מוסיף את הטיקרים שהתקבלו ל-`knownSymbolsRef`, ומרחיב (merge) את ה-state `recommendationsBySymbol` הקיים עם התוצאה החדשה (לא מחליף לגמרי — כדי לא לאבד נתונים שהתקבלו בעברי).
- בכשל (רשת/שרת) — נבלע בשקט (`catch` ריק עם הערה): המניות החסרות פשוט יוצגו כ"לא זמין" ב-UI, ולא יגרמו לקריסת העמוד.
- `loading` הוא בוליאני גלובלי (לא לפי טיקר) שמסמן אם יש בקשה באוויר.
- כמו הרבה hooks אחרים בפרויקט, יש ניקוי (`cancelled` flag) כדי למנוע `setState` על קומפוננטה שכבר לא מותקנת (unmounted).
- מחזיר `{ recommendationsBySymbol, loading }` — מפה של טיקר→נתוני המלצה.

---

### `src/hooks/useAuth.js`

**תפקיד**

מרכז את כל מצב האימות (authentication) של האפליקציה: מי המשתמש המחובר, בדיקת session בעליית האפליקציה, והתנתקות. חולץ במפורש מ-`App.js` (לפי הערת הקוד) ללא שינוי התנהגות — כדי לפצל את הלוגיקה למודול נפרד וקריא יותר.

**לוגיקה מפורטת**

- State: `user` (אובייקט המשתמש או `null`) ו-`authLoading` (בוליאני, מתחיל כ-`true` — משמש להציג מסך טעינה עד שהבדיקה הראשונית מסתיימת).
- `authHeader()` — פונקציית עזר שמחזירה `{ Authorization: 'Bearer <token>' }` אם קיים טוקן (נשלף מ-`getAuthToken()` מ-`../authToken`), או אובייקט ריק אם לא. פונקציה זו **לא** יציבה (reference חדש בכל רנדר) — עובדה שמוזכרת בהערות של hooks אחרים (למשל `usePortfolioSnapshots.js`) כמשמעותית, כי היא לא יכולה לשמש כתלות ב-`useEffect`/`useCallback` בלי לגרום ל-loop אינסופי.
- ב-mount (effect עם `[]` תלות): מבצע `GET /api/auth/me` עם `credentials: 'include'` (עוגיות session) וגם עם `authHeader()` (טוקן, למקרה של cross-site cookies חסומים — ראו `.env.example`, `CROSS_SITE_COOKIES`). בהצלחה שם את `d.user` (או `null` אם חסר) ל-state; בכשל — `null`. תמיד ב-`finally` מכבה את `authLoading`.
- `login(authenticatedUser, token)` — פונקציה שנקראת מ-`AuthView` לאחר login/signup מוצלחים: שומרת טוקן (אם סופק) באמצעות `setAuthToken`, ומעדכנת את ה-state `user`.
- `logout()` — קוראת `POST /api/auth/logout` (עם credentials + authHeader), מתעלמת משגיאות (best-effort — גם אם קריאת ה-server נכשלת, מבוצע ניקוי מקומי), מנקה את הטוקן המקומי עם `clearAuthToken()`, ומאפסת `user` ל-`null`. בכוונה **לא** מטפלת בנתוני התיק (portfolio) — האחריות לאיפוס תיק מוטלת על הקורא (למשל `usePortfolioData().resetPortfolio()`), הפרדת אחריות מכוונת.
- מחזיר `{ user, authLoading, authHeader, login, logout }`.

---

### `src/hooks/useBenchmarkHistory.js`

**תפקיד**

מביא סגירות יומיות היסטוריות של מדד ייחוס (S&P 500 או TA-125), החל מתאריך התחלה נתון, כדי להשוות את עקומת השווי של התיק מול מדד שוק. מדובר בנתוני שוק פומביים (`server/benchmarkRoutes.js`) — אינו דורש אימות, בשונה מ-`usePortfolioSnapshots.js`.

**לוגיקה מפורטת**

- פרמטרים: `benchmarkKey` (`'sp500'` | `'ta125'` | `null`/`undefined`) ו-`fromDate` (מחרוזת בפורמט `YYYY-MM-DD`, בפועל תאריך תמונת-המצב הראשונה של התיק).
- State: `points` (מערך נקודות), `loading`, `error` (מחרוזת עברית).
- אם `benchmarkKey` או `fromDate` חסרים — מאפס `points` ו-`error` ולא מבצע כלל קריאה (early return בתוך ה-effect).
- אחרת: `GET /api/benchmark-history/{benchmarkKey}?from={fromDate}`.
- בהצלחה: `setPoints` למערך `d.points` (עם הגנת `Array.isArray`, נופל למערך ריק אם לא תקין).
- בכשל: מאפס `points` לריק ומציב הודעת שגיאה בעברית: "לא ניתן היה לטעון את נתוני מדד הייחוס כרגע".
- תלויות ה-effect: `[benchmarkKey, fromDate]` — כאשר אחד מהם משתנה, מתבצעת קריאה חדשה. יש דגל `cancelled` לניקוי מירוץ תוצאות (race condition) בין בקשות.
- מחזיר `{ points, loading, error }`.

---

### `src/hooks/useCpiIndex.js`

**תפקיד**

שולף את מדד המחירים לצרכן (CPI) הישראלי — הן את הערך העדכני ביותר, והן ערכים היסטוריים לפי חודשים ספציפיים שרלוונטיים לתיק (למשל תאריכי רכישת מניות או הפקדות לקופות גמל). זהו נתון שמתעדכן רק אחת לחודש במקור (הלמ"ס), כך שהאפליקציה טוענת אותו מחדש בכל פתיחה, ולא כ"רענון יומי".

**לוגיקה מפורטת**

- פרמטר: `monthKeys` (מערך מחרוזות חודש, למשל `'2024-03'`).
- State מאוחד באובייקט אחד: `{ currentIndex, currentIndexMonth, indexByMonth, loading, error }` — התחלה: `loading: true`.
- `monthKeysKey` — `JSON.stringify` של מערך ה-months הייחודיים והממוינים; משמש כתלות יחידה של ה-effect (כמו הדפוס של `missingKey` בהוקים אחרים) כדי למנוע רה-פטצ' על כל רנדר עם reference מערך חדש.
- בתוך ה-effect: מריץ **שתי בקשות במקביל** באמצעות `Promise.all`:
  1. `GET /api/cpi/latest` — המדד האחרון הידוע.
  2. `POST /api/cpi/months` עם `{ months: uniqueMonths }` — רק אם יש בכלל חודשים ברשימה; אחרת `Promise.resolve(null)` (לא שולח בקשה סתם).
- מפרש את שתי התוצאות: `latest` (אם `ok`) ו-`monthsMap` (אם קיים ו-`ok`).
- מעדכן state שלם: `currentIndex`/`currentIndexMonth` מ-`latest.value`/`latest.month` (או `null` אם נכשל), `indexByMonth` מ-`monthsMap`, `loading: false`, ו-`error` — מחרוזת עברית "לא ניתן היה למשוך את מדד המחירים לצרכן" אם `latest` נכשל.
- `catch` חוץ: אם יש שגיאת רשת/JSON — קובע `error` להיות הודעת השגיאה הטכנית (`err.message`) או fallback עברי "שגיאה במשיכת המדד".
- לפי תיעוד ה-JSDoc בראש הקובץ: התכנון המכוון הוא שקוד קורא (consumer) יציג נפילה חזרה (fallback) לחישוב ישן/מקומי כל עוד המדד עדיין לא נטען או שהמשיכה נכשלה — כדי שהאפליקציה "לעולם לא תישבר" בשל תקלה במקור חיצוני (הלמ"ס).
- מחזיר את כל אובייקט ה-state (`currentIndex, currentIndexMonth, indexByMonth, loading, error`).

---

### `src/hooks/useDividendData.js`

**תפקיד**

מביא נתוני דיבידנד (תשואת דיבידנד עתידית, payout, תאריך תשלום הבא, וכן היסטוריית תשלומים בפועל) עבור מספר טיקרים אמריקאיים בבת אחת, לשימוש בסקציית "מעקב דיבידנדים". באופן מעניין, אותה תגובת שרת "רוכבת" גם על שדות תאריך רבעון קרוב (`earningsDateEpoch`, `epsEstimateAverage` וכו') המשמשים את סקציית "לוח רבעונים" — לפי ההערה בקוד, זה נעשה כדי לא לכפול קריאת רשת (ראו `fetchYahooDividendSummary` ב-`yahooQuotes.js`). נתונים פומביים — לא דורש אימות. מבנה זהה ל-`useStockSectors.js`.

**לוגיקה מפורטת**

- פרמטרים: `symbols` (מערך טיקרים) ו-`fromDate` (מחרוזת `YYYY-MM-DD`, אידיאלית תאריך הרכישה האמריקאית הראשונה בתיק — כדי שהשרת ישלוף היסטוריית דיבידנד עד מספיק אחורה).
- אותו דפוס "cache חדש-בלבד" כמו ב-`useAnalystRecommendations`/`useStockNews`/`useStockSectors`: נרמול טיקרים, `knownSymbolsRef` (Set) לזכירת מה שכבר נבקש, `missingSymbols`+`missingKey` לחישוב מה חדש והבטחת יציבות תלות effect.
- אם אין טיקרים חדשים — לא מתבצעת קריאה.
- קורא `POST /api/dividend-data` עם body `{ symbols: missingSymbols, from: fromDate || undefined }`.
- בהצלחה: מוסיף טיקרים ל-`knownSymbolsRef`, ומרחיב (merge) את `dividendsBySymbol`.
- בכשל: נבלע בשקט — הסמלים החסרים יוצגו כ"לא זמין" בטבלה, לא קריסה.
- מחזיר `{ dividendsBySymbol, loading }`.

---

### `src/hooks/useHoldingsPriceHistory.js`

**תפקיד**

מביא סגירות יומיות היסטוריות עבור מספר טיקרים אמריקאיים בבקשה אחת מרוכזת, לשימוש בחישוב **מטריצת קורלציה** בין הנכסים בתיק (ראו `src/utils/correlationAnalysis.js`). נתונים פומביים (`server/correlationRoutes.js`), אין אימות. מבנה זהה ל-`useStockSectors.js`.

**לוגיקה מפורטת**

- פרמטר: `symbols` (מערך טיקרים גולמי, בפועל `americanStocks.map(s => s.stockName)`).
- אותו דפוס דיוק בדיוק כמו ב-hooks האחרים באותה משפחה: נרמול, `knownSymbolsRef`, `missingSymbols`, `missingKey`.
- קורא `POST /api/stock-price-history` עם `{ symbols: missingSymbols }`.
- בהצלחה: מרחיב (merge) `historyBySymbol` עם `d.history`, ומעדכן את `knownSymbolsRef`.
- בכשל: נבלע בשקט — הסימבולים החסרים פשוט נופלים מתוך חישוב מטריצת הקורלציה, לא גורמים לקריסה.
- מחזיר `{ historyBySymbol, loading }`.

---

### `src/hooks/useMonthlySnapshots.js`

**תפקיד**

מנהל תמונות-מצב **חודשיות** של שווי התיק — פעולה מכוונת ונפרדת מתמונות המצב ה"יומיות" של `usePortfolioSnapshots.js` (הבחנה מתועדת ב-`server/monthlySnapshotRoutes.js`). אותו דפוס בסיסי: fetch-on-mount + חשיפת פעולות שמירה/עדכון/מחיקה. מבנה זה תומך בטבלת ההיסטוריה החודשית ב-`PortfolioAnalysisView.js`.

**לוגיקה מפורטת**

- מקבל `user` ו-`authHeader` (מ-`useAuth`) כפרמטרים.
- Stateים רבים: `monthlySnapshots` (מערך), `monthlySnapshotsLoading`, ולכל פעולה — צמד state עצמאי לדגל-בתהליך ולהודעת-שגיאה: `savingMonthly`/`saveMonthlyError`, `updatingMonth`/`updateMonthlyError` (updatingMonth מחזיק את **מפתח החודש** הנוכחי בעדכון, לא רק בוליאני — כך UI יכול להראות spinner בשורה הספציפית), `deletingMonth`/`deleteMonthlyError` (בדומה), `addingManual`/`addManualError`.
- `fetchMonthlySnapshots` (`useCallback`, תלות `[user]` בלבד — `authHeader` מכוונת לא נכללת, כדי לא לגרום ללופ אינסופי, לפי ההערה שמצטטת את ההערה המזהה ב-`usePortfolioSnapshots.js`): אם אין `user` — מאפס למערך ריק; אחרת `GET /api/portfolio-monthly-snapshots` עם credentials+authHeader. בכשל — **לא** מוחק את הנתונים הקיימים (משמר את טבלת ההיסטוריה שכבר מוצגת למשתמש) — רק ב-`catch` ריק עם הערה מפורשת.
- `useEffect` עם תלות `[fetchMonthlySnapshots]` מפעיל את הפצ'ץ' הראשוני (ומדי פעם שה-`user` משתנה, כי זה תלות של ה-`useCallback`).
- `saveMonthlySnapshot(totalValueILS, breakdown)`: מאמת `user.id` ותקינות מספרית (`Number.isFinite` וגדול מ-0); `POST /api/portfolio-monthly-snapshot` עם `{ totalValueILS, breakdown }`; בהצלחה — `await fetchMonthlySnapshots()` לרפרש הרשימה; בכשל — הודעת שגיאה עברית "שמירת השמירה החודשית נכשלה, נסה שוב".
- `updateMonthlySnapshot(month, totalValueILS, breakdown)`: מתקן חודש שכבר נשמר (זרימת "ערוך"/"שמור עריכה" בטבלת ההיסטוריה) — **לעולם לא יוצר חודש חדש** (לפי הערת ה-route בשרת). `PUT /api/portfolio-monthly-snapshot/{encodeURIComponent(month)}`. מחזיר בוליאני (`true`/`false`) בהצלחה/כשל כדי שהקורא יחליט אם לצאת ממצב עריכה.
- `deleteMonthlySnapshot(month)`: מוחק חודש שמור לצמיתות (כפתור "מחק"). `DELETE /api/portfolio-monthly-snapshot/{month}`. מחזיר בוליאני כדי שהקורא ידע לנקות בחירה שמפנה לחודש שנמחק.
- `addManualMonthlySnapshot(month, totalValueILS, breakdown)`: השלמה בדיעבד ("➕ הוספה ידנית") לחודש עבר שהמשתמש שכח לשמור — בשונה מ-`saveMonthlySnapshot` (שתמיד "עכשיו"), כאן `month` נבחר על ידי המשתמש. `POST /api/portfolio-monthly-snapshot/manual` עם `{ month, totalValueILS, breakdown }`.
- כל פעולות ה-write קוראות בסיום ל-`fetchMonthlySnapshots()` לרפרש את הרשימה (עדכון אופטימי לא מבוצע — יש round-trip מלא לשרת).
- מחזיר אובייקט גדול עם כל ה-state ופונקציות הפעולה.

---

### `src/hooks/usePortfolioData.js`

**תפקיד**

Hook מרכזי לניהול **חמשת מערכי ההחזקות** של התיק: מניות ישראליות, מניות אמריקאיות, קופות גמל, יתרות בנק, קרנות כספיות, וקרנות חיסכון בנקאיות. אחראי על טעינה מהשרת בעת login, שמירה חזרה, ואיפוס בעת logout. חולץ מ-`App.js` (ללא שינוי התנהגות).

**לוגיקה מפורטת**

- מקבל `user` ו-`authHeader`.
- Stateים: `israeliStocks, americanStocks, pensionFunds, bankBalances, cashFunds, bankSavingsFunds` (כל אחד מערך), `portfolioReady` (בוליאני — מסמן שהטעינה הראשונית הסתיימה, גם אם נכשלה), `hasUnsavedChanges`, `saveLoading`, `saveError`, `lastSavedAt`.
- `userRef` — `useRef` שמוחזק מסונכרן עם `user` בכל רנדר (`userRef.current = user`), כדי לקרוא ל-`user` העדכני מתוך `savePortfolio` בלי לגרום ל-effect/callback dependency issues.
- `persistTimerRef` + `clearPendingSaveTimer` — טיימר שמור "לעתיד" (autosave מבוזר-זמן), לפי ההערה בקוד **הוא כרגע אינו בשימוש בפועל** — נשמר מהקוד המקורי של App.js ללא שינוי התנהגות, רק מנוקה, לעולם לא מתוזמן.
- **Effect טעינה** (תלות `[user]`): אם אין `user` — מאפס `portfolioReady`, `hasUnsavedChanges`, `saveError`, `lastSavedAt` ומחזיר. אחרת: `GET /api/portfolio` עם credentials+authHeader. בהצלחה: ממלא את כל שישה ה-arrays — `israeliStocks` עובר נירמול נוסף באמצעות `normalizeIsraeliStocksFromStorage` (מ-`utils/formatters`), שאר השדות מוגנים ב-`Array.isArray` עם fallback למערך ריק. מאפס `hasUnsavedChanges`, `saveError`, וקובע `lastSavedAt` לזמן נוכחי. בכשל: מאפס את כל שישה ה-arrays למערכים ריקים (תיק "נקי"). ב-`finally`: מדליק `portfolioReady`.
- `buildCurrentPortfolioSnapshot()` — בונה אובייקט snapshot משישה ה-state הנוכחיים (לא מ-ref, אלא סגירה על ה-state הנוכחי בזמן הקריאה).
- `savePortfolio()`: מגן מפני קריאות כפולות (`if (saveLoading) return`), מנקה טיימר pending, `PUT /api/portfolio` עם body ה-snapshot המלא. בכשל — מנסה לקרוא טקסט שגיאה מהתשובה (`r.text()`), נופל ל-`statusText`, מדפיס אזהרה ל-console, וקובע הודעת שגיאה עברית "שמירה נכשלה. בדוק התחברות/רשת ונסה שוב." בהצלחה — מכבה `hasUnsavedChanges` ומעדכן `lastSavedAt`.
- `replacePortfolio(snapshot)` — מחליף בבת אחת את כל שישה ה-arrays (משמש לייבוא חד-פעמי מ-legacy localStorage). שם `hasUnsavedChanges` ל-`false` ו-`lastSavedAt` לעכשיו (כלומר מתייחס לזה כ"נשמר").
- `resetPortfolio()` — מנקה טיימר pending, מאפס את כל שישה ה-arrays, `portfolioReady`, `hasUnsavedChanges`, `saveError`, `lastSavedAt`. משמש ב-logout.
- מחזיר אובייקט גדול עם כל ה-state, ה-setters (`setIsraeliStocks` וכו') ופעולות (`savePortfolio, replacePortfolio, resetPortfolio, clearPendingSaveTimer`).

---

### `src/hooks/usePortfolioSnapshots.js`

**תפקיד**

מנהל היסטוריית שווי תיק **יומית** — לשימוש בעקומת השווי (equity curve), חישוב Max Drawdown, תנודתיות/שארפ ריאליים, והשוואה למדד ייחוס בעמוד הניתוח. השמירה הייתה בעבר אוטומטית (מתבצעת כל פעם ששווי שאינו-אפס חושב, פעם ביום), אך שונתה לשמירה **ידנית בלבד** (כפתור ב-`HomeView.js`) — כי הגרסה האוטומטית יכלה להירשם לפני שמחירים חיים סופקו במלואם, ולתפוס תמונת מצב מ-render חלקי/מיושן.

**לוגיקה מפורטת**

- מקבל `user`, `authHeader`.
- Stateים: `snapshots` (מערך), `snapshotsLoading`, `saving`, `saveError`, `lastSavedAt`.
- `fetchSnapshots` (`useCallback`, תלות `[user]` בלבד — עם הערה מפורשת שהזכירה "אותה תקלה זוהתה במקור: `authHeader()` הוא reference חדש כל רנדר של `useAuth()`, וחייב **לא** להיות תלות, אחרת נגרם loop אינסופי (bug אמיתי שתועד)"). קורא `GET /api/portfolio-snapshots`; בכשל — משמר את מה שהיה קודם (לא מוחק את הגרף שהמשתמש כבר צופה בו).
- Effect שמפעיל `fetchSnapshots()` בעת mount ובכל שינוי ל-`user` (דרך שינוי ה-`useCallback`).
- `saveSnapshotNow(totalValueILS, breakdown)` — מקבל את הערכים **כפרמטרים בזמן הקריאה** (ולא כ-hook params ריאקטיביים) בכוונה מפורשת: כך שהוא תופס את השווי המחושב הנוכחי **בזמן הלחיצה על הכפתור**, ולא closure מיושן. מאמת `user.id` ו-`totalValueILS` תקין (`> 0`). `POST /api/portfolio-snapshot` עם `{ totalValueILS, breakdown }`. בהצלחה: מעדכן `lastSavedAt` ומרפרש (`await fetchSnapshots()`). בכשל: הודעת שגיאה עברית "שמירת תמונת המצב נכשלה, נסה שוב".
- מחזיר `{ snapshots, snapshotsLoading, saveSnapshotNow, saving, saveError, lastSavedAt, refetchSnapshots: fetchSnapshots }` — חושף במפורש גם את פונקציית ה-refetch לקריאה חוזרת מבחוץ.

---

### `src/hooks/usePriceRefresh.js`

**תפקיד**

מפעיל **פולינג (polling) אוטומטי** של מחירי מניות (ישראליות דרך TASE, אמריקאיות דרך Yahoo) כל 10 שניות, ומעדכן את מערכי ה-state של החזקות בזמן אמת — אלא אם המשתמש נמצא באמצע ערכי/הוספה. חולץ מ-`App.js` ללא שינוי התנהגות. שלא כמו שאר ה-hooks במסמך זה, hook זה **לא מחזיר ערך** — הוא side-effect בלבד שמעדכן state שהועבר לו כפרמטר.

**לוגיקה מפורטת**

- קבוע `POLLING_INTERVAL_MS = 10000` (10 שניות).
- מקבל אובייקט props: `israeliStocks, americanStocks, setIsraeliStocks, setAmericanStocks, isEditMode, editingField, isAddingNewStock`.
- מפעיל `setInterval` בתוך `useEffect` (עם תלות `[israeliStocks.length, americanStocks.length, isEditMode, isAddingNewStock]` — כלומר ה-interval מוחלף/מופעל מחדש אם מספר ההחזקות משתנה או אם נכנסים/יוצאים ממצב עריכה/הוספה). מנקה את ה-interval ב-cleanup.
- כל 10 שניות, אם `isEditMode || editingField || isAddingNewStock` — הפונקציה מדלגת (return מוקדם) כדי לא לדרוס נתונים שהמשתמש כרגע עורך.
- **עבור מניות ישראליות**: מקבץ החזקות לפי `stockName` (סימבול) כך שכל טיקר ייגש רק פעם אחת ל-`fetchIsraeliStockPrice`. אם התקבל `priceData` תקין — ממיר את המחיר מ**אגורות לשקלים** (`currentPrice / 100`, כי TASE מחזיר באגורות) ומעדכן `currentPrice` + `dailyChangePercent` לכל ההחזקות עם אותו סימבול. אם לא התקבל מחיר — משמר את הנתון הקיים ללא שינוי.
- **עבור מניות אמריקאיות**: קורא קודם `fetchExchangeRate()` (שער דולר/שקל אחד לכל ההחזקות), ואז מקבץ לפי סימבול וקורא `fetchCurrentPrice` לכל טיקר. אם התקבל מחיר — מעדכן `currentPrice`, `dailyChangePercent`, ו-`currentExchangeRate` (עם fallback לשער הקודם אם לא סופק שער חדש). אם הקריאה נכשלה (try/catch) — משמר את ההחזקה כמו שהיא, רק מעדכן את שער החליפין.
- לבסוף מעדכן את שני מערכי ה-state (`setIsraeliStocks`, `setAmericanStocks`) עם המערכים המחודשים במלואם.
- לא מחזיר דבר — כל התוצאה זורמת דרך ה-setters שהתקבלו כפרמטרים.

---

### `src/hooks/useRebalanceTargets.js`

**תפקיד**

טוען ושומר את **יעדי הקצאת האיזון-מחדש (rebalancing targets)** האישיים של המשתמש — נתוני תכנון פרטיים שדורשים אימות (`server/rebalanceRoutes.js`). אותו דפוס fetch/auth כמו `usePortfolioData.js`.

**לוגיקה מפורטת**

- מקבל `user`, `authHeader`.
- State: `targets` (מתחיל כ-`null` — משמעו "לא נטען עדיין / אין נתון שמור", מבחין בין "עדיין לא ידוע" לבין "ידוע וריק"), `loading`, `saving`, `saveError`.
- Effect טעינה (תלות `[user]`): אם אין `user` — מאפס `targets` ל-`null` ומחזיר. אחרת `GET /api/rebalance-targets`; בהצלחה — `d.targets || emptyTargets()` (fallback לאובייקט יעדים ריק מ-`utils/rebalancing`); בכשל — גם כן `emptyTargets()` (כלומר גם כשל שרת מוביל לאובייקט יעדים "ריק" תקין ולא ל-`null`, כדי שה-UI יוכל להציג טופס ריק לעריכה).
- `saveTargets(newTargets)` (`useCallback`, תלות ריקה `[]` — פונקציה יציבה שנקראת בכל שינוי כי היא לא סוגרת (`closure`) על state חוץ מ-authHeader/setState שהם עצמם stable references): `PUT /api/rebalance-targets` עם body ה-targets המלאים. בהצלחה — מעדכן `targets` מהתשובה (`d.targets || newTargets` — fallback לקלט אם השרת לא החזיר) ומחזיר `true`. בכשל — קובע הודעת שגיאה עברית "שמירת היעדים נכשלה, נסו שוב" ומחזיר `false`.
- מחזיר `{ targets, loading, saving, saveError, saveTargets }`.

---

### `src/hooks/useStockNews.js`

**תפקיד**

מביא כותרות חדשות עדכניות עבור מספר טיקרים אמריקאיים בבקשה אחת מרוכזת, לשימוש בסקציית "חדשות רלוונטיות". נתונים פומביים (`server/newsRoutes.js`) — ללא אימות. מבנה זהה ל-`useStockSectors.js`.

**לוגיקה מפורטת**

- אותו דפוס בדיוק כמו `useAnalystRecommendations`/`useDividendData`/`useHoldingsPriceHistory`: נרמול טיקרים, `knownSymbolsRef` (Set) כ-cache, `missingSymbols`+`missingKey`.
- `POST /api/stock-news` עם `{ symbols: missingSymbols }`.
- בהצלחה: מרחיב (merge) `newsBySymbol` עם `d.news`, מסמן את הסימבולים כ"ידועים".
- בכשל: נבלע בשקט — הסימבולים החסרים פשוט לא תורמים כותרות לפיד.
- מחזיר `{ newsBySymbol, loading }`.

---

### `src/hooks/useStockResearch.js`

**תפקיד**

מביא נתוני fundamentals (יסודות) עבור **סימבול בודד** שחיפש המשתמש, לעמוד "חקר מניות". נתונים פומביים (`server/stockResearchRoutes.js`) — ללא אימות. בשונה מ-hooks כמו `useStockSectors`/`useDividendData` (שמבצעים batch-fetch על כל התיק), זהו חיפוש בודד שמשתנה כל פעם שהמשתמש בוחר מניה אחרת לבדיקה.

**לוגיקה מפורטת**

- פרמטר: `symbol` (מחרוזת או `null` — `null` = לא נבחר עדיין, לא מתבצעת קריאה).
- State: `research` (אובייקט או `null`), `loading`, `error` (מחרוזת עברית).
- אם `!symbol` — מאפס `research` ו-`error`, לא קורא לשרת.
- אחרת: `GET /api/stock-research/{encodeURIComponent(symbol)}`.
- בהצלחה: `setResearch(d.research || null)`.
- בכשל: מאפס `research` ל-`null` וקובע `error` להיות "לא ניתן היה לטעון נתוני מנייה כרגע".
- תלות effect: `[symbol]` — כל שינוי בסימבול הנבחר מפעיל fetch חדש, עם ניקוי (`cancelled`) למניעת race condition בין תוצאות.
- מחזיר `{ research, loading, error }`.

---

### `src/hooks/useStockSearch.js`

**תפקיד**

מספק **autocomplete** (השלמה אוטומטית) של טיקרים/שמות חברות עבור תיבת החיפוש בעמוד "חקר מניות". פונה ל-`GET /api/stock-search` (מוגדר ב-`server/stockResearchRoutes.js`). כולל **debounce** כדי לא לשלוח בקשה על כל הקשת מקש.

**לוגיקה מפורטת**

- קבוע `DEBOUNCE_MS = 300` (300 מילישניות).
- פרמטר: `query` (מחרוזת חיפוש גולמית, לא נחתכת/מתוקפת עדיין על ידי הקורא).
- State: `results` (מערך), `loading`.
- ה-effect (תלות `[query]`): חותך רווחים (`trim()`); אם האורך קטן מ-2 תווים — מאפס `results` לריק ולא מבצע כלל בקשה (וגם לא debounce).
- אחרת: מגדיר `setTimeout` בן 300ms. כשהטיימר מסתיים (ולא בוטל) — מדליק `loading`, ומריץ `GET /api/stock-search?q={encodeURIComponent(trimmed)}`. בהצלחה — `setResults` (מוגן ב-`Array.isArray`, fallback לריק). בכשל — מאפס `results` לריק.
- ב-cleanup: קובע `cancelled = true` **וגם** מנקה את ה-timeout (`clearTimeout`) — כך אם המשתמש מקליד עוד תו לפני שחלפו 300ms, הטיימר הקודם מבוטל לגמרי (זה מה שמייצר את התנהגות ה-debounce), ואם הבקשה כבר יצאה לדרך אך הקומפוננטה כבר לא רלוונטית (או ה-query השתנה) — סימון ה-`cancelled` מונע `setState` על תגובה מיושנת.
- מחזיר `{ results, loading }`.

---

### `src/hooks/useStockSectors.js`

**תפקיד**

מזהה סקטור/תעשייה עבור רשימת טיקרים אמריקאיים, בבקשה אחת מרוכזת, עם cache ב-state כדי שרנדורים חוזרים (או מעבר חזרה לעמוד הניתוח) לא יבצעו fetch חדש לסימבולים שכבר יש להם תשובה. נתונים פומביים (`server/sectorRoutes.js`) — ללא אימות. זהו ה-hook ה"אב-טיפוס" שההערות בקבצים אחרים (`useAnalystRecommendations`, `useDividendData`, `useHoldingsPriceHistory`, `useStockNews`) מפנות אליו כדוגמה למבנה החזרה.

**לוגיקה מפורטת**

- זהה 1:1 בתבנית לשאר משפחת ה-batch hooks: נרמול טיקרים (`trim`, `toUpperCase`, סינון ריקים, הסרת כפילויות), `knownSymbolsRef` (`useRef(new Set())`) לזכירת סימבולים שכבר טופלו, `missingSymbols` (הסימבולים החדשים), `missingKey` (מחרוזת ממוינת לתלות ה-effect).
- אם אין סימבולים חדשים — אין קריאה.
- `POST /api/stock-sectors` עם `{ symbols: missingSymbols }`.
- בהצלחה: מסמן את הסימבולים שהתקבלו כ"ידועים" ב-`knownSymbolsRef`, ומרחיב (merge) את `sectorBySymbol`.
- בכשל: נבלע בשקט — החזקות ללא סקטור מסווג מוצגות כ"לא מסווג" (unclassified) בפילוח, לא קריסה.
- מחזיר `{ sectorBySymbol, loading }`.

---

### `src/hooks/useTheme.js`

**תפקיד**

מנהל את מצב עיצוב האתר (בהיר/כהה) — העדפת **מכשיר/דפדפן**, לא נתון תיק/חשבון, ולכן נשמר ב-`localStorage` ולא בשרת. מיושם באמצעות תכונת `data-theme` על תג ה-`<html>`, כדי ש-`App.css` (בלוקים `:root` ו-`:root[data-theme='light']`) יגיבו אליו ב-CSS custom properties. ברירת המחדל היא **כהה** — החלטת מוצר מפורשת: העיצוב הכהה הוא ה"מראה האמיתי" של האפליקציה (שהוכח ב-`StockResearchView`), והמצב הבהיר הוא ה-opt-out.

**לוגיקה מפורטת**

- קבוע `STORAGE_KEY = 'afikinvest_theme'`.
- `readStoredTheme()` — פונקציה טהורה שקוראת מ-`localStorage`; מחזירה `'light'` רק אם הערך השמור הוא בדיוק `'light'`, אחרת (כולל שגיאת גישה ל-localStorage, למשל במצב פרטי) — `'dark'`.
- State: `theme`, מאותחל באמצעות `useState(readStoredTheme)` (lazy initializer — נקרא רק פעם אחת, בעת ה-mount הראשוני).
- Effect (תלות `[theme]`): מגדיר `document.documentElement.setAttribute('data-theme', theme)`, ומנסה לשמור ל-`localStorage` (עטוף ב-`try/catch` — אם נכשל, ה-theme פשוט לא ישמר בין רענוני עמוד, אך האפליקציה לא תיקרוס).
- `toggleTheme()` — מחליף בין `'dark'` ל-`'light'` (toggle פשוט, לא שלושה מצבים).
- מחזיר `{ theme, toggleTheme }`.

---
