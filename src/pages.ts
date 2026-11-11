import { escape, html, page } from "./html.ts";

const REPO_URL = "https://github.com/yosefor/expanses-bot";
const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${REPO_URL}`;

/** Public page to send to someone who wants their own copy of the bot. */
export function installPage(): Response {
  return html(
    page(
      "בוט הוצאות משלכם בוואטסאפ",
      `<p>שולחים לבוט <b>50 סופר</b> והוא רושם את ההוצאה. שולחים <b>סיכום</b> ומקבלים את כל ההוצאות לפי חודשים.
      אפשר לצרף בני משפחה לחשבון משותף.</p>
      <p>הבוט רץ בחשבון Cloudflare שלכם, בחינם, והנתונים נשמרים רק אצלכם. ההתקנה לוקחת בערך חצי שעה.</p>

      <section><h2>מה צריך</h2><ul>
        <li>חשבון פייסבוק.</li>
        <li>מספר טלפון לבוט שלא מחובר לוואטסאפ (למשל סים נוסף). צריך לקבל בו SMS או שיחה פעם אחת, לאימות.</li>
        <li>כתובת מייל, לפתיחת חשבון ב-Cloudflare וב-GitHub (שניהם בחינם).</li>
      </ul></section>

      <section><h2><span class="muted">1.</span> התקנה ב-Cloudflare</h2>
        <p><a class="button big" href="${escape(DEPLOY_URL)}" target="_blank" rel="noopener">התקנה ב-Cloudflare</a></p>
        <ol>
          <li>נרשמים ל-Cloudflare או נכנסים, ומחברים חשבון GitHub כשמבקשים (שם נשמר עותק של הקוד).</li>
          <li>בשדה <b>ADMIN_PASSWORD</b> בוחרים סיסמה לדף ההגדרות של הבוט. שומרים אותה.</li>
          <li>לוחצים <b>Create and deploy</b> ומחכים כשתי דקות.</li>
        </ol></section>

      <section><h2><span class="muted">2.</span> חיבור לוואטסאפ</h2>
        <p>בסוף ההתקנה מופיעה כתובת שנגמרת ב-<code>workers.dev</code>. פותחים אותה ונכנסים עם הסיסמה (שם משתמש: כל דבר).
        הדף מלווה אתכם שלב אחרי שלב: פתיחת אפליקציה ב-Meta, חיבור המספר, ובדיקה.</p>
        <p class="muted">שמרו את הכתובת: זה דף ההגדרות של הבוט שלכם.</p></section>

      <p class="muted">קוד פתוח: <a href="${REPO_URL}">${REPO_URL.replace("https://", "")}</a></p>`,
    ),
  );
}

/** Privacy policy, needed to switch the Meta app to Live. */
export function privacyPage(origin: string): Response {
  return html(
    page(
      "מדיניות פרטיות",
      `<section><p>בוט ההוצאות בכתובת <code>${escape(origin)}</code> שומר רק את מה שנחוץ כדי לרשום ולסכם הוצאות:
      מספר הטלפון ושם הפרופיל בוואטסאפ של מי שכותב לבוט, הסכום והתיאור של כל הוצאה, ומתי נשלחה.</p>
      <p>המידע נשמר במסד הנתונים של מפעיל הבוט ב-Cloudflare, לא מועבר לאף אחד אחר ולא משמש לפרסום.
      ההודעות נשלחות ומתקבלות דרך WhatsApp Business Platform של Meta.</p>
      <p>כדי למחוק את המידע שלכם, פנו למי שהזמין אתכם להשתמש בבוט.</p></section>
      <section dir="ltr"><h2>Privacy policy</h2>
      <p>This expenses bot stores only what it needs to record and summarize expenses: the WhatsApp number and profile name
      of people who message it, and each expense's amount, description and time. The data is kept in the bot operator's
      Cloudflare database, is not shared with anyone else and is not used for advertising. Messages go through Meta's
      WhatsApp Business Platform. To have your data deleted, contact the person who invited you to the bot.</p></section>`,
    ),
  );
}
