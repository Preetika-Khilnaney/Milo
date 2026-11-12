// Demo merchant network and product catalog.
// Merchant risk signals are what a payments platform would know from its own data.
const merchants = {
  m1: {
    id: "m1",
    name: "Northwind Electronics",
    accountAgeMonths: 74,
    rating: 4.8,
    disputeRate: 0.004,
    crossBorder: false,
    country: "US",
  },
  m2: {
    id: "m2",
    name: "PixelBazaar Global",
    accountAgeMonths: 2,
    rating: 3.7,
    disputeRate: 0.052,
    crossBorder: true,
    country: "SG",
  },
  m3: {
    id: "m3",
    name: "Greenleaf Home",
    accountAgeMonths: 38,
    rating: 4.6,
    disputeRate: 0.011,
    crossBorder: false,
    country: "US",
  },
  m4: {
    id: "m4",
    name: "Kestrel Outdoor Co.",
    accountAgeMonths: 19,
    rating: 4.3,
    disputeRate: 0.019,
    crossBorder: true,
    country: "DE",
  },
};

const products = [
  { id: "p1", merchantId: "m1", name: "Aurora ANC Wireless Headphones", category: "audio", price: 189.0, tags: ["headphones", "noise cancelling", "wireless", "bluetooth"] },
  { id: "p2", merchantId: "m2", name: "Aurora ANC Wireless Headphones (import)", category: "audio", price: 139.0, tags: ["headphones", "noise cancelling", "wireless", "bluetooth"] },
  { id: "p3", merchantId: "m1", name: "Slate 75% Mechanical Keyboard", category: "computer", price: 119.0, tags: ["keyboard", "mechanical", "desk"] },
  { id: "p4", merchantId: "m2", name: "Slate 75% Mechanical Keyboard (import)", category: "computer", price: 84.0, tags: ["keyboard", "mechanical", "desk"] },
  { id: "p5", merchantId: "m1", name: 'Lumen 27" 4K Monitor', category: "computer", price: 329.0, tags: ["monitor", "display", "4k", "screen"] },
  { id: "p6", merchantId: "m3", name: "Arc LED Desk Lamp", category: "home", price: 42.0, tags: ["lamp", "light", "desk"] },
  { id: "p7", merchantId: "m3", name: "Ergo Mesh Office Chair", category: "home", price: 245.0, tags: ["chair", "office", "ergonomic", "desk"] },
  { id: "p8", merchantId: "m4", name: "Ridge 2-Person Hiking Tent", category: "outdoor", price: 210.0, tags: ["tent", "camping", "hiking"] },
  { id: "p9", merchantId: "m4", name: "Trail Insulated Water Bottle", category: "outdoor", price: 28.0, tags: ["bottle", "water", "hiking"] },
  { id: "p10", merchantId: "m2", name: "Nova Smartwatch S2", category: "wearables", price: 99.0, tags: ["watch", "smartwatch", "fitness"] },
  { id: "p11", merchantId: "m1", name: "Nova Smartwatch S2", category: "wearables", price: 149.0, tags: ["watch", "smartwatch", "fitness"] },
  { id: "p12", merchantId: "m3", name: "Pour-Over Coffee Set", category: "home", price: 36.0, tags: ["coffee", "kitchen", "gift"] },
];

function getProduct(id) {
  const p = products.find((x) => x.id === id);
  return p ? { ...p, merchant: merchants[p.merchantId] } : null;
}

function searchProducts(query = "", maxPrice) {
  const words = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  const scored = products
    .map((p) => {
      const hay = (p.name + " " + p.category + " " + p.tags.join(" ")).toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) || hay.includes(w.replace(/s$/, "")) ? 1 : 0), 0);
      return { p, score };
    })
    .filter(({ p, score }) => (words.length === 0 || score > 0) && (!maxPrice || p.price <= maxPrice))
    .sort((a, b) => b.score - a.score || a.p.price - b.p.price)
    .slice(0, 6);
  return scored.map(({ p }) => ({ ...p, merchant: merchants[p.merchantId] }));
}

module.exports = { merchants, products, getProduct, searchProducts };
