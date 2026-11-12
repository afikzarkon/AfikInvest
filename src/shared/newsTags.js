// Ported from day-trader-skill (MIT, Jake Schincariol)
//
// Labels for the news feed, shared by the server (newsService.js tags each
// item with these keys) and the client (NewsView.js shows the Hebrew names).

// Topic tags a headline or filing can carry, in display order.
const NEWS_TAG_LABELS_HE = {
  earnings: 'דוחות',
  analyst: 'אנליסטים',
  legal: 'משפטי',
  deal: 'עסקה / מיזוג',
  capital: 'דיבידנד / הון',
  people: 'הנהלה',
  risk: 'סיכון',
  halt: 'עצירת מסחר',
  regulatory: 'רגולציה',
  macro: 'מאקרו'
};

// SEC 8-K item codes -> Hebrew.
const ITEMS_8K_HE = {
  '1.01': 'הסכם מהותי',
  '1.02': 'סיום הסכם מהותי',
  '1.03': 'פשיטת רגל / כינוס נכסים',
  '1.05': 'אירוע סייבר מהותי',
  '2.01': 'רכישה או מכירה של נכסים',
  '2.02': 'תוצאות כספיות',
  '2.03': 'חוב חדש',
  '2.04': 'האצת חוב',
  '2.05': 'עלויות ארגון מחדש',
  '2.06': 'ירידת ערך',
  '3.01': 'הודעת מחיקה מהמסחר',
  '3.02': 'הנפקת מניות לא רשומה',
  '3.03': 'שינוי בזכויות בעלי המניות',
  '4.01': 'החלפת רואה חשבון',
  '4.02': 'דוחות קודמים אינם אמינים עוד',
  '5.01': 'שינוי שליטה',
  '5.02': 'שינוי בדירקטוריון / בהנהלה',
  '5.03': 'שינוי תקנון או שנת כספים',
  '5.07': 'תוצאות הצבעת בעלי מניות',
  '7.01': 'גילוי לפי Regulation FD',
  '8.01': 'אירועים אחרים',
  '9.01': 'נספחים'
};

const NEWS_SOURCE_LABELS_HE = { yahoo: 'Yahoo Finance', sec: 'SEC EDGAR' };

exports.NEWS_TAG_LABELS_HE = NEWS_TAG_LABELS_HE;
exports.ITEMS_8K_HE = ITEMS_8K_HE;
exports.NEWS_SOURCE_LABELS_HE = NEWS_SOURCE_LABELS_HE;
