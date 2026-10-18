# הגדרת התחברות והרשמה - AfikInvest

המדריך הזה מסביר מה צריך להגדיר מחוץ לקוד כדי שההתחברות עם Google ו-Facebook, בדיקת הבוטים (Turnstile) ודף ההגדרות יעבדו ב-production.

**בלי שום הגדרה מכל אלה האתר ממשיך לעבוד** בהרשמה עם אימייל וסיסמה, באימות מייל, בקישור כניסה (Magic Link) ובאימות דו-שלבי. כפתור של ספק מופיע רק אחרי שהמפתחות שלו מוגדרים בשרת.

## איך זה עובד (בקצרה)

1. הכפתור "המשך עם Google" שולח את הדפדפן לשרת: `https://api.afikinvest.com/api/auth/oauth/google`.
2. השרת מעביר ל-Google, ו-Google מחזיר לשרת: `https://api.afikinvest.com/api/auth/oauth/google/callback`.
3. השרת מעביר את הדפדפן לאתר: `https://www.afikinvest.com/auth/callback?code=...`. הקוד חד-פעמי ותקף ל-2 דקות, והאתר מחליף אותו ב-session. ה-token עצמו לא עובר ב-URL.

לכן **ה-Redirect URI שרושמים אצל הספקים הוא תמיד כתובת השרת (`API_PUBLIC_URL`)**, לא כתובת האתר.

---

## 1. משתני סביבה

### ב-Render (השרת)
| משתנה | ערך | חובה? |
|---|---|---|
| `API_PUBLIC_URL` | `https://api.afikinvest.com` (בלי `/` בסוף) | חובה בשביל Google/Facebook ו-unsubscribe בלחיצה אחת |
| `APP_URL` | `https://www.afikinvest.com` | כבר קיים |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | מ-Google Cloud (סעיף 2) | לכפתור Google |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | מ-Meta (סעיף 3) | לכפתור Facebook |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | מ-Cloudflare (סעיף 4) | מומלץ |
| `SUPPORT_EMAIL` | הכתובת שאליה מגיעות פניות מטופס העזרה | רשות (ברירת מחדל: `EMAIL_USER`) |

### ב-Vercel (האתר)
| משתנה | ערך |
|---|---|
| `REACT_APP_SUPPORT_EMAIL` | כתובת יצירת הקשר שתוצג בדפי התנאים והפרטיות (רשות) |

אחרי שינוי משתנה ב-Vercel צריך לעשות **Redeploy**: הערכים נצרבים באתר בזמן הבנייה.

---

## 2. Google (Google Cloud Console)

אפשר להשתמש באותו Project שבו מוגדר שליחת המיילים (Gmail API), אבל **ליצור OAuth Client נפרד** לכניסה.

1. **https://console.cloud.google.com** ← בחרו את ה-Project (או צרו חדש בשם AfikInvest).
2. **Google Auth Platform ← Branding** (במסכים ישנים: OAuth consent screen):
   - App name: `AfikInvest`
   - User support email: כתובת התמיכה
   - App domain:
     - Application home page: `https://www.afikinvest.com`
     - Privacy policy: `https://www.afikinvest.com/privacy`
     - Terms of service: `https://www.afikinvest.com/terms`
   - Authorized domains: `afikinvest.com`
   - Developer contact: הכתובת שלכם
3. **Audience**:
   - User type: **External**.
   - אחרי שהכול עובד: **Publish app**. במצב Testing רק משתמשי בדיקה רשומים יכולים להיכנס.
4. **Data Access ← Add or remove scopes**: רק `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. אלה ה-scopes הבסיסיים, ולא נדרשת בשבילם בדיקת אימות של Google.
5. **Clients ← Create client**:
   - Application type: **Web application**
   - Name: `AfikInvest sign-in`
   - **Authorized redirect URIs**, הוסיפו את כולם:
     - `http://localhost:5000/api/auth/oauth/google/callback` (פיתוח מקומי)
     - `https://api.afikinvest.com/api/auth/oauth/google/callback` (production)
     - אם יש שרת staging לבדיקות preview, גם את הכתובת שלו (ראו סעיף 5)
   - Authorized JavaScript origins: לא נדרש (ההתחברות עוברת דרך השרת).
6. העתיקו את **Client ID** ואת **Client secret** ל-Render: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

---

## 3. Facebook (Meta for Developers)

1. **https://developers.facebook.com/apps** ← **Create app**.
   - Use case: **Authenticate and request data from users with Facebook Login**.
   - App name: `AfikInvest`, contact email.
2. **App settings ← Basic**:
   - App domains: `afikinvest.com`
   - Privacy Policy URL: `https://www.afikinvest.com/privacy`
   - Terms of Service URL: `https://www.afikinvest.com/terms`
   - **User data deletion**: בחרו **Data deletion callback URL** והזינו:
     `https://api.afikinvest.com/api/auth/facebook/data-deletion`
   - App icon (1024×1024) ו-Category.
   - העתיקו **App ID** ו-**App Secret** ל-Render: `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`.
3. **Use cases ← Facebook Login ← Settings** (במסכים ישנים: Products ← Facebook Login ← Settings):
   - Client OAuth login: Yes. Web OAuth login: Yes.
   - Enforce HTTPS: Yes. Use Strict Mode for redirect URIs: Yes.
   - **Valid OAuth Redirect URIs**:
     - `https://api.afikinvest.com/api/auth/oauth/facebook/callback`
     - בפיתוח, Facebook מאפשר את `http://localhost:5000/...` אוטומטית כל עוד האפליקציה במצב Development.
4. **Permissions**: רק `email` ו-`public_profile`. שתיהן ב-Standard Access, ולא נדרשים App Review או Business Verification.
5. בראש העמוד: העבירו את האפליקציה ממצב **Development** ל-**Live**. זה דורש שכתובות הפרטיות ומחיקת הנתונים יהיו מוגדרות.

**חשוב לגבי Facebook:** Facebook לא מבטיח שהאימייל שהוא מוסר מאומת.

לכן אם כתובת מ-Facebook תואמת לחשבון קיים, **החשבון לא מקושר אוטומטית**: נשלח מייל אישור לכתובת של החשבון, והקישור נוצר רק אחרי האישור. משתמש חדש מ-Facebook מתבקש לאמת את המייל כמו בהרשמה רגילה. כך אי אפשר להשתלט על חשבון דרך אימייל לא מאומת.

**מה ה-Data Deletion Callback עושה:** כשמשתמש מסיר את האפליקציה בהגדרות Facebook, Facebook שולח בקשה חתומה. השרת:
- בודק את החתימה עם `FACEBOOK_APP_SECRET`;
- מוחק את הקישור ל-Facebook ואת השם שהתקבל ממנו;
- מחזיר ל-Facebook קישור לדף סטטוס.

החשבון עצמו ב-AfikInvest לא נמחק. מחיקה מלאה נמצאת בהגדרות ← מחיקת חשבון.

---

## 4. Cloudflare Turnstile (הגנה מבוטים, מומלץ)

1. **https://dash.cloudflare.com** ← **Turnstile** ← **Add widget**.
2. Hostnames: `afikinvest.com`, `www.afikinvest.com`, `localhost`.
3. Widget mode: **Managed**.
4. העתיקו **Site Key** ל-`TURNSTILE_SITE_KEY` ו-**Secret Key** ל-`TURNSTILE_SECRET_KEY` (שניהם ב-Render).

בלי המפתחות הבדיקה כבויה. גם אז ההרשמה מוגנת על ידי honeypot, הגבלת קצב לפי IP ולפי אימייל, וחסימת כתובות זמניות.

---

## 5. סביבות preview של Vercel

Google ו-Facebook לא תומכים ב-wildcard ב-redirect URIs, והכתובת של כל preview ב-Vercel משתנה. מכיוון שה-redirect הוא לשרת ולא לאתר, הפתרון המומלץ:

1. שרת staging נפרד ב-Render (למשל `afikinvest-api-staging`), עם `API_PUBLIC_URL` משלו, ו-`APP_URL` של alias קבוע ב-Vercel (למשל `staging.afikinvest.com`).
2. להוסיף ל-Google ול-Facebook את ה-callback של שרת ה-staging.
3. ב-Vercel, להגדיר `REACT_APP_API_URL` לשרת ה-staging בסביבת Preview בלבד.

בלי staging: ב-preview אפשר להתחבר עם אימייל וסיסמה, אבל לא דרך Google/Facebook.

---

## 6. מסד הנתונים (migrations)

**אין צורך להריץ שום דבר ידנית.**

- השרת מריץ את ה-migrations בעלייה. הן מתועדות בטבלה `schema_migrations` ורצות פעם אחת.
- הן רק **מוסיפות** טבלאות ועמודות ולא מוחקות או משנות שום דבר קיים.
- משתמשים קיימים מסומנים כבעלי אימייל מאומת, כך שאף אחד לא ננעל מחוץ לחשבון.

מומלץ לגבות את מסד הנתונים (Supabase/Neon ← Backups) לפני ה-deploy הראשון.

---

## 7. משימה יומית

ה-workflow ב-GitHub (`scheduled-jobs.yml`) מריץ פעם ביום את `accounts.maintenance`:
- מחיקה סופית של חשבונות שתקופת החסד שלהם (14 יום) הסתיימה;
- מייל תזכורת יום-יומיים לפני המחיקה;
- ניקוי sessions וטוקנים שפג תוקפם.

הוא משתמש ב-secrets הקיימים `AFIKINVEST_API_URL` ו-`CRON_SECRET`. הרצה ידנית: GitHub ← Actions ← Scheduled jobs ← Run workflow ← `accounts.maintenance`.

---

## 8. בדיקה אחרי ההגדרה

1. `https://www.afikinvest.com`: מופיעים הכפתורים "המשך עם Google" ו-"המשך עם Facebook".
2. כניסה עם Google בחשבון חדש: מופיע מסך אישור תנאים, ואחריו onboarding.
3. כניסה עם Google בכתובת של חשבון קיים: נכנסים לאותו חשבון, ובהגדרות ← חשבון ואבטחה Google מופיע כמחובר.
4. הגדרות ← חשבון ואבטחה ← "חיבור" ל-Facebook, ואז חזרה לדף ההגדרות עם הודעת "חובר".
5. Facebook ← Settings ← Apps and Websites ← הסרת האפליקציה: ביומן האבטחה מופיע "מחיקת מידע מ-Facebook".
6. הרצת הבדיקות המקומיות: `npm test`, ואז `npm run build && npm run e2e`.
