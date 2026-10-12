require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");
const { ensureSeedAccounts } = require("./services/authService");

const PORT = process.env.PORT || 5001;

connectDB().then(async () => {
  // The first boot with passwords: the staff accounts, each with its default password.
  const made = await ensureSeedAccounts().catch((err) => {
    console.error("staff accounts seed failed:", err.message);
    return 0;
  });
  if (made) console.log(`staff accounts: created ${made}`);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
