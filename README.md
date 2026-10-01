# GXPLAY backend + Admin panel

## Chalane ka tarika (Node 22.13+ chahiye, koi npm install nahi)
    cp .env.example .env      # ADMIN_USER / ADMIN_PASS badal lein
    node --disable-warning=ExperimentalWarning server.js
- Website:  http://localhost:3000
- Admin:    http://localhost:3000/admin

Aapki index.html `public/` folder me hai aur pehle se `/api/...` use karti hai, isliye usme koi change nahi chahiye.
Data `data/gxplay.db` (SQLite) me save hota hai - isko backup rakhein.

## Deploy (mobile se aasan): Render.com / Railway / VPS
- Start command: `npm start`
- Env vars: ADMIN_USER, ADMIN_PASS, (optional) TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
- IMPORTANT: ek persistent disk lagayein aur `DATA_DIR` uss disk ke path par set karein, warna redeploy par users/balance delete ho jayenge.
- Games ka result ab server decide karta hai. MAX_BET env se max bet set kar sakte hain (default 100000).
- HTTPS zaroor use karein (Render/Railway automatic dete hain).

## Admin panel me kya hai
Home (stats) - Users (search, edit, balance add/remove, block, password reset, user ka address change, delete, CSV)
Deposits (approve = balance auto add / reject) - Addresses (website ke deposit addresses badlein, turant live)
More (Telegram alert, admin password, activity log)
Naya user register hone par admin page par alert + beep, aur Telegram set ho to phone par message.

## Naya (deposit / withdrawal / currency)
- Deposit ke niche ab "Amount + TXID" form hai: coin/network badalne par typed value nahi jaati, TXID validate hoti hai, aur neeche apni recent deposits ki status (Pending/Completed/Rejected) dikhti hai.
- Withdrawal: Wallet > Withdraw. User coin + network + address + amount + password deta hai. Amount turant balance se hold hota hai.
  Admin > Withdraw tab: "Paid" (crypto bhej ke, optional payout TXID) ya "Reject" (amount user ko wapas refund).
- Transactions menu me user ki deposits + withdrawals dikhti hain.
- Currency: balance, games, bet box sab ek hi selected currency me. Game ke upar currency button / slot-live game page ka pill dabao: saari currencies ki searchable list.
  Server balance INR me store karta hai; display ke liye `fiats` table (index.html) ke rates use hote hain - real rates chahiye to us table ko update karein.
- Limits (INR me): .env me MIN_DEPOSIT (default 1), MIN_WITHDRAW (default 100).
- Bug fix: admin ki Deposits list (pending filter) crash ho rahi thi, ab theek hai.

## Slots (naya)
- Slot game ke page par "Real Play" dabao to ab 3x3, 5-line slot machine khulti hai (Sports / Live games abhi bhi locked).
- Result server decide karta hai: `POST /api/play/slots` (server.js me SLOT_P3 / SLOT_W table, RTP ~94.7%). Payout badalna ho to wahi table edit karein.
- Banners (Promotions) ab Deposit / VIP / Refer section kholte hain.

## Lucky Tiger + Rabbit + Panda + Ox (apne original)
- GX Originals me "Lucky Tiger" 🐯: 3x3, 5 lines, tiger = wild. Tiger aaye to tigers lock hote hain aur baaki respin hote hain (×2, ×3, ×5).
- Server decide karta hai: `POST /api/play/tiger` (server.js me TG_* table, RTP ~96%).
- Ye PG Soft ya kisi aur provider ka game/art/naam nahi hai.

## Naya: Landing + editable "Game unavailable" message
- Site khulte hi GXPLAY ka animated splash aata hai, phir website upar Login / Sign up ke saath.
- Guest user kisi bhi cheez par tap kare to Sign up khulta hai.
- Admin panel > More > "Game unavailable message" se lock wale games ka title/message badlein (turant live).
