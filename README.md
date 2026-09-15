# shekel-system

השרת של מערכת שק"ל — **מכללה לכל · תרבות לכל · קליטה · הספרייה**.
Express + Mongoose מול MongoDB Atlas, ומגיש גם את הקליינט (React) הבנוי
מתוך `client-dist/`, כך שתהליך אחד הוא כל האפליקציה.

## הרצה

```bash
npm install
cp .env.example .env      # ולמלא DATABASE / DATABASE_PASSWORD
npm run dev               # nodemon, פורט 5001
npm start                 # ייצור
```

- `GET /api/health` — בדיקת חיים.
- `GET /` (וכל כתובת שאינה `/api/...`) — האפליקציה מתוך `client-dist/`
  (נכסים עם hash נשמרים ב-cache לשנה, `index.html` אף פעם, וכל URL של
  React Router נופל ל-`index.html`).
- כל ה-API תחת `/api/...` — הפירוט המלא ב-`postman.md` בפרויקט הראשי.

## עדכון הקליינט

הקוד של הקליינט חי בפרויקט הראשי (`../client`). כדי לפרסם גרסה חדשה:

```bash
cd ../client
npm run deploy            # vite build → מעתיק ודורס את server/client-dist
cd ../server
git add client-dist && git commit -m "client build" && git push
```

## בדיקות ונתונים

```bash
npm test                              # Jest + Supertest על Mongo בזיכרון
node scripts/seedTestData.js          # עולם הטסט (world:"test")
node scripts/seedPokemon.js           # עולם הפוקימון
node scripts/backupJson.js            # גיבוי EJSON של כל האוספים (ל-backups/, לא ב-git)
```

## משתני סביבה

| שם | תפקיד |
|---|---|
| `DATABASE` | מחרוזת חיבור ל-Atlas עם `<PASSWORD>` |
| `DATABASE_PASSWORD` | הסיסמה שמוחלפת במחרוזת |
| `PORT` | ברירת מחדל 5001 |
| `NODE_ENV` | `development` מדפיס לוג בקשות |
| `UPLOAD_DIR` | תיקיית הקבצים שהועלו (מסמכי קליטה, כריכות); ברירת מחדל `./uploads` |

מה לא נכנס לריפו (`.gitignore`): `.env`, `node_modules/`, `uploads/`, `backups/`,
תיקיית הסקרייפינג של סנזי ודוחות המיגרציה.
