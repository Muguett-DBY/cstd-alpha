const endpoint = process.env.COMPANY_EVIDENCE_REFRESH_URL || "https://alpha.custard.top/api/company-evidence-refresh";
const token = process.env.COMPANY_EVIDENCE_REFRESH_TOKEN;
if (!token) {
  throw new Error("COMPANY_EVIDENCE_REFRESH_TOKEN is required.");
}

const body = {
  userId: process.env.COMPANY_EVIDENCE_USER_ID || undefined,
  watchlistId: process.env.COMPANY_EVIDENCE_WATCHLIST_ID || undefined,
  limit: Number(process.env.COMPANY_EVIDENCE_LIMIT || 50),
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(body),
});

const text = await response.text();
if (!response.ok) {
  throw new Error(`Company evidence refresh failed: ${response.status} ${text.slice(0, 1000)}`);
}

console.log(text);
