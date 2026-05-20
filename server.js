require('dotenv').config();
const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const bcrypt   = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const jwt      = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { getDistance } = require("geolib");

const app  = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET          = process.env.JWT_SECRET          || "void-secret-change-in-production";
const ADMIN_PASSWORD      = process.env.ADMIN_PASSWORD      || "2434";
const UPI_ID              = process.env.UPI_ID              || "9573520949-2@ybl";
const MERCHANT_NAME       = process.env.MERCHANT_NAME       || "VOID Store";
const FREE_DELIVERY_ABOVE = parseInt(process.env.FREE_DELIVERY_ABOVE) || 999;

const mailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const cs = new CloudinaryStorage({ cloudinary, params: async () => ({ folder:"nickx_products", public_id:uuidv4(), allowed_formats:["jpg","jpeg","png","webp"], transformation:[{width:1200,height:1600,crop:"limit",quality:"auto"}] }) });
const heroCs = new CloudinaryStorage({ cloudinary, params: async () => ({ folder:"nickx_hero", public_id:"hero_gif", allowed_formats:["jpg","jpeg","png","webp","gif"], transformation:[{width:1080,height:1080,crop:"limit",quality:"auto"}] }) });
const upload = multer({ storage:cs, limits:{ fileSize:20*1024*1024 } });
const uploadHero = multer({ storage:heroCs, limits:{ fileSize:20*1024*1024 } });
const getImageUrl = f => f ? f.path : null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));

// ── Data helpers ─────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname,"data");
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
function loadJson(file, def=[]) {
  const p=path.join(DATA_DIR,file);
  if(!fs.existsSync(p)){fs.writeFileSync(p,JSON.stringify(def,null,2));return def;}
  return JSON.parse(fs.readFileSync(p,"utf-8"));
}
function saveJson(file,data){ fs.writeFileSync(path.join(DATA_DIR,file),JSON.stringify(data,null,2)); }

function loadProducts(){
  const p=path.join(DATA_DIR,"products.json");
  if(!fs.existsSync(p)){
    const seed=[
      {id:"001",name:"VOID TEE",price:1999,category:"T-Shirts",description:"Heavyweight 400gsm cotton. Oversized silhouette. Washed black.",colors:["#000000"],sizes:["XS","S","M","L","XL"],imageFile:null,featured:true,stock:24,createdAt:new Date().toISOString()},
      {id:"002",name:"PHANTOM HOODIE",price:3499,category:"Hoodies",description:"French terry loopback. Drop shoulder. Double-lined hood.",colors:["#000000"],sizes:["S","M","L","XL","XXL"],imageFile:null,featured:true,stock:12,createdAt:new Date().toISOString()},
      {id:"003",name:"SIGNAL JACKET",price:5999,category:"Outerwear",description:"Nylon shell. YKK zippers. Neon reflective piping.",colors:["#000000"],sizes:["S","M","L","XL"],imageFile:null,featured:false,stock:8,createdAt:new Date().toISOString()}
    ];
    fs.writeFileSync(p,JSON.stringify(seed,null,2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(p,"utf-8"));
}
function saveProducts(p){ fs.writeFileSync(path.join(DATA_DIR,"products.json"),JSON.stringify(p,null,2)); }

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAdmin(req,res,next){
  const auth=req.headers.authorization;
  if(!auth?.startsWith("Bearer ")) return res.status(401).json({success:false,message:"Unauthorized"});
  try{ const d=jwt.verify(auth.split(" ")[1],JWT_SECRET); if(!d.admin) throw 0; next(); }
  catch{ res.status(401).json({success:false,message:"Invalid admin token"}); }
}
function requireCustomer(req,res,next){
  const auth=req.headers.authorization;
  if(!auth?.startsWith("Bearer ")) return res.status(401).json({success:false,message:"Please login"});
  try{ req.customer=jwt.verify(auth.split(" ")[1],JWT_SECRET); next(); }
  catch{ res.status(401).json({success:false,message:"Session expired"}); }
}

// ── Haversine formula ───────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ── Nominatim geocoding ─────────────────────────────────────────────────────────
async function geocodeAddress(address) {
  try {
    const encoded = encodeURIComponent(address);
    const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`, {
      headers: { 'User-Agent': 'nickx-store' }
    });
    const data = await response.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
    return null;
  } catch (err) {
    console.error('Geocoding error:', err.message);
    return null;
  }
}

// ── Delivery config ─────────────────────────────────────────────────────────────
function loadDeliveryConfig() {
  return loadJson("delivery-config.json", {
    sourceAddress: "",
    sourceLat: null,
    sourceLng: null,
    zones: [
      { label: "Local", minKm: 0, maxKm: 15, price: 20 },
      { label: "City", minKm: 15, maxKm: 40, price: 30 },
      { label: "State", minKm: 40, maxKm: 200, price: 60 },
      { label: "National", minKm: 200, maxKm: 99999, price: 100 }
    ]
  });
}
function saveDeliveryConfig(config) { saveJson("delivery-config.json", config); }
function normalizeZones(zones = []) {
  return [...zones]
    .map(z => ({
      label: z.label,
      minKm: Number(z.minKm),
      maxKm: Number(z.maxKm),
      price: Number(z.price)
    }))
    .filter(z => z.label && Number.isFinite(z.minKm) && Number.isFinite(z.maxKm) && Number.isFinite(z.price))
    .sort((a, b) => a.minKm - b.minKm);
}
function getNationalMaxZone(zones = []) {
  const validZones = normalizeZones(zones);
  return validZones.reduce((max, zone) => {
    if (!max) return zone;
    if (zone.maxKm > max.maxKm) return zone;
    if (zone.maxKm === max.maxKm && zone.price > max.price) return zone;
    return max;
  }, null);
}
function getZoneForDistance(distanceKm, zones = []) {
  const validZones = normalizeZones(zones);
  const matched = validZones.find(z => distanceKm >= z.minKm && distanceKm <= z.maxKm);
  if (matched) return matched;
  return getNationalMaxZone(validZones);
}

app.get("/api/delivery-config",(req,res)=>res.json({success:true,data:loadDeliveryConfig()}));
app.post("/api/delivery-config", requireAdmin, async(req,res)=>{
  try {
    const config = req.body;
    saveDeliveryConfig(config);
    res.json({success:true,data:config});
  } catch(err) { res.status(500).json({success:false,message:err.message}); }
});
app.post("/api/calculate-delivery", async(req,res)=>{
  try {
    const { destLat, destLng } = req.body;
    const config = loadDeliveryConfig();
    const sourceLat = Number(config.sourceLat);
    const sourceLng = Number(config.sourceLng);
    if (!Number.isFinite(sourceLat) || !Number.isFinite(sourceLng)) {
      return res.json({success:false,message:"Source location not configured"});
    }
    const customerLat = Number(destLat);
    const customerLng = Number(destLng);
    if (!Number.isFinite(customerLat) || !Number.isFinite(customerLng)) {
      return res.status(400).json({success:false,message:"Customer coordinates are required"});
    }

    const distanceMeters = getDistance(
      { latitude: sourceLat, longitude: sourceLng },
      { latitude: customerLat, longitude: customerLng }
    );
    const distanceKm = distanceMeters / 1000;

    let price = 80;
    if (distanceKm <= 60) price = 40;
    else if (distanceKm <= 100) price = 55;
    else if (distanceKm <= 200) price = 70;

    res.json({success:true,distanceKm:Math.round(distanceKm * 10) / 10,price});
  } catch(err) { res.status(500).json({success:false,message:err.message}); }
});

// ── Config endpoint ───────────────────────────────────────────────────────────
app.get("/api/config",(req,res)=>{
  const heroGifUrl = loadJson("hero-gif.json", {url:null}).url;
  const config = loadDeliveryConfig();
  const maxZone = getNationalMaxZone(config.zones);
  res.json({success:true,upiId:UPI_ID,merchantName:MERCHANT_NAME,deliveryCharge:maxZone ? maxZone.price : 0,freeDeliveryAbove:FREE_DELIVERY_ABOVE,heroGifUrl});
});

// ── Hero GIF upload ────────────────────────────────────────────────────────────
app.post("/api/hero-gif",requireAdmin,uploadHero.single("heroGif"),async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({success:false,message:"No file uploaded"});
    const heroGifUrl = getImageUrl(req.file);
    saveJson("hero-gif.json",{url:heroGifUrl});
    res.json({success:true,url:heroGifUrl});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});

// ── Admin auth ────────────────────────────────────────────────────────────────
app.post("/api/auth/login",(req,res)=>{
  if(req.body.password===ADMIN_PASSWORD){
    res.json({success:true,token:jwt.sign({admin:true},JWT_SECRET,{expiresIn:"24h"})});
  } else res.status(401).json({success:false,message:"Invalid password"});
});

// ── Customer auth ─────────────────────────────────────────────────────────────
app.post("/api/customers/register", async(req,res)=>{
  try{
    const {name,email,password,phone}=req.body;
    if(!name||!email||!password) return res.status(400).json({success:false,message:"Name, email and password required"});
    const customers=loadJson("customers.json",[]);
    if(customers.find(c=>c.email===email.toLowerCase())) return res.status(400).json({success:false,message:"Email already registered. Please login."});
    const hashed=await bcrypt.hash(password,10);
    const customer={id:uuidv4(),name:name.trim(),email:email.toLowerCase().trim(),password:hashed,phone:phone||"",addresses:[],resetOTP:null,otpExpiry:null,createdAt:new Date().toISOString()};
    customers.push(customer);
    saveJson("customers.json",customers);
    const token=jwt.sign({customerId:customer.id,email:customer.email},JWT_SECRET,{expiresIn:"30d"});
    res.status(201).json({success:true,token,customer:{id:customer.id,name:customer.name,email:customer.email}});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});

app.post("/api/customers/login", async(req,res)=>{
  try{
    const {email,password}=req.body;
    const customers=loadJson("customers.json",[]);
    const c=customers.find(x=>x.email===email?.toLowerCase());
    if(!c||!(await bcrypt.compare(password,c.password))) return res.status(401).json({success:false,message:"Invalid email or password"});
    const token=jwt.sign({customerId:c.id,email:c.email},JWT_SECRET,{expiresIn:"30d"});
    res.json({success:true,token,customer:{id:c.id,name:c.name,email:c.email,phone:c.phone}});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});

app.post("/api/forgot-password", async(req,res)=>{
  try {
    const email = req.body.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({success:false,message:"Email is required"});
    const customers = loadJson("customers.json",[]);
    const idx = customers.findIndex(c => c.email === email);
    if (idx === -1) return res.status(404).json({success:false,message:"No account found with this email"});
    const otp = `${Math.floor(100000 + Math.random() * 900000)}`;
    const otpExpiry = Date.now() + 10 * 60 * 1000;
    customers[idx].resetOTP = otp;
    customers[idx].otpExpiry = otpExpiry;
    saveJson("customers.json", customers);
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(500).json({success:false,message:"Email service is not configured"});
    }
    await mailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Password Reset OTP",
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e5e5;"><h2 style="margin:0 0 12px;">Password Reset Request</h2><p style="margin:0 0 12px;">Use this OTP to reset your password:</p><div style="font-size:30px;font-weight:700;letter-spacing:8px;margin:12px 0 16px;">${otp}</div><p style="margin:0;color:#666;">This OTP expires in 10 minutes.</p></div>`
    });
    res.json({success:true,message:"OTP sent to your email"});
  } catch(err) {
    res.status(500).json({success:false,message:err.message});
  }
});

app.post("/api/reset-password", async(req,res)=>{
  try {
    const email = req.body.email?.toLowerCase().trim();
    const otp = req.body.otp?.trim();
    const newPassword = req.body.newPassword;
    if (!email || !otp || !newPassword) return res.status(400).json({success:false,message:"Email, OTP and new password are required"});
    if (newPassword.length < 6) return res.status(400).json({success:false,message:"Password must be at least 6 characters"});
    const customers = loadJson("customers.json",[]);
    const idx = customers.findIndex(c => c.email === email);
    if (idx === -1) return res.status(404).json({success:false,message:"No account found with this email"});
    const customer = customers[idx];
    if (!customer.resetOTP || !customer.otpExpiry) return res.status(400).json({success:false,message:"No active OTP request"});
    if (Date.now() > Number(customer.otpExpiry)) return res.status(400).json({success:false,message:"OTP has expired"});
    if (customer.resetOTP !== otp) return res.status(400).json({success:false,message:"Invalid OTP"});
    customers[idx].password = await bcrypt.hash(newPassword, 10);
    customers[idx].resetOTP = null;
    customers[idx].otpExpiry = null;
    saveJson("customers.json", customers);
    res.json({success:true,message:"Password reset successful"});
  } catch(err) {
    res.status(500).json({success:false,message:err.message});
  }
});

app.get("/api/customers/me", requireCustomer,(req,res)=>{
  const c=loadJson("customers.json",[]).find(x=>x.id===req.customer.customerId);
  if(!c) return res.status(404).json({success:false,message:"Not found"});
  res.json({success:true,customer:{id:c.id,name:c.name,email:c.email,phone:c.phone,addresses:c.addresses}});
});

app.put("/api/customers/address", requireCustomer,(req,res)=>{
  const customers=loadJson("customers.json",[]);
  const idx=customers.findIndex(x=>x.id===req.customer.customerId);
  if(idx===-1) return res.status(404).json({success:false,message:"Not found"});
  const address={id:uuidv4(),...req.body,savedAt:new Date().toISOString()};
  if(!customers[idx].addresses) customers[idx].addresses=[];
  customers[idx].addresses.unshift(address);
  customers[idx].addresses=customers[idx].addresses.slice(0,5);
  saveJson("customers.json",customers);
  res.json({success:true,address});
});

// ── Products ──────────────────────────────────────────────────────────────────
app.get("/api/products",(req,res)=>{
  let p=loadProducts();
  if(req.query.category) p=p.filter(x=>x.category===req.query.category);
  if(req.query.featured==="true") p=p.filter(x=>x.featured);
  res.json({success:true,data:p});
});
app.get("/api/products/:id",(req,res)=>{
  const p=loadProducts().find(x=>x.id===req.params.id);
  if(!p) return res.status(404).json({success:false,message:"Not found"});
  res.json({success:true,data:p});
});
app.post("/api/products", requireAdmin, upload.single("image"),(req,res)=>{
  try{
    const {name,price,category,description,colors,sizes,featured,stock}=req.body;
    if(!name||!price||!category) return res.status(400).json({success:false,message:"name, price, category required"});
    const products=loadProducts();
    const product={id:uuidv4().slice(0,8).toUpperCase(),name:name.toUpperCase(),price:parseFloat(price),category,description:description||"",colors:colors?JSON.parse(colors):["#000000"],sizes:sizes?JSON.parse(sizes):["S","M","L","XL"],imageFile:getImageUrl(req.file),modelFile:null,featured:featured==="true",stock:parseInt(stock)||0,createdAt:new Date().toISOString()};
    products.push(product);
    saveProducts(products);
    res.status(201).json({success:true,data:product});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});
app.patch("/api/products/:id", requireAdmin, upload.single("image"),(req,res)=>{
  const products=loadProducts();
  const idx=products.findIndex(p=>p.id===req.params.id);
  if(idx===-1) return res.status(404).json({success:false,message:"Not found"});
  const updated={...products[idx],...req.body};
  if(req.file) updated.imageFile=getImageUrl(req.file);
  if(req.body.colors) updated.colors=JSON.parse(req.body.colors);
  if(req.body.sizes)  updated.sizes=JSON.parse(req.body.sizes);
  if(req.body.price)  updated.price=parseFloat(req.body.price);
  if(req.body.featured!==undefined) updated.featured=req.body.featured==="true";
  products[idx]=updated;
  saveProducts(products);
  res.json({success:true,data:updated});
});
app.delete("/api/products/:id", requireAdmin,(req,res)=>{
  const products=loadProducts();
  const idx=products.findIndex(p=>p.id===req.params.id);
  if(idx===-1) return res.status(404).json({success:false,message:"Not found"});
  const [removed]=products.splice(idx,1);
  saveProducts(products);
  res.json({success:true,data:removed});
});
app.get("/api/categories",(req,res)=>res.json({success:true,data:[...new Set(loadProducts().map(p=>p.category))]}));

// ── Orders ────────────────────────────────────────────────────────────────────
app.post("/api/orders",(req,res)=>{
  try{
    const {items,address,subtotal,deliveryCharge,total,customerEmail,upiRef,distanceKm,zoneLabel}=req.body;
    if(!items?.length||!address||!total) return res.status(400).json({success:false,message:"Missing required fields"});
    // Decrement stock
    const products=loadProducts();
    for(const item of items){
      const pi=products.findIndex(p=>p.id===item.id);
      if(pi!==-1&&products[pi].stock>=item.qty) products[pi].stock-=item.qty;
    }
    saveProducts(products);
    const orders=loadJson("orders.json",[]);
    const orderId=`ORD-${Date.now().toString(36).toUpperCase()}-${uuidv4().slice(0,4).toUpperCase()}`;
    const order={id:orderId,items,address,subtotal:parseFloat(subtotal),deliveryCharge:parseFloat(deliveryCharge),total:parseFloat(total),customerName:address.fullName,customerEmail:customerEmail||"",customerPhone:address.mobile,upiRef:upiRef||"",status:"payment_pending",distanceKm:distanceKm||null,zoneLabel:zoneLabel||null,createdAt:new Date().toISOString()};
    const auth=req.headers.authorization;
    if(auth?.startsWith("Bearer ")){
      try{ const d=jwt.verify(auth.split(" ")[1],JWT_SECRET); if(d.customerId) order.customerId=d.customerId; }catch{}
    }
    orders.unshift(order);
    saveJson("orders.json",orders);
    res.status(201).json({success:true,data:order});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});

app.get("/api/orders/my", requireCustomer,(req,res)=>{
  const orders=loadJson("orders.json",[]).filter(o=>o.customerId===req.customer.customerId);
  res.json({success:true,data:orders});
});
app.get("/api/orders", requireAdmin,(req,res)=>res.json({success:true,data:loadJson("orders.json",[])}));
app.patch("/api/orders/:id/status", requireAdmin,(req,res)=>{
  const orders=loadJson("orders.json",[]);
  const idx=orders.findIndex(o=>o.id===req.params.id);
  if(idx===-1) return res.status(404).json({success:false,message:"Not found"});
  orders[idx].status=req.body.status;
  orders[idx].updatedAt=new Date().toISOString();
  saveJson("orders.json",orders);
  res.json({success:true,data:orders[idx]});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((err,req,res,next)=>{ console.error(err); res.status(500).json({success:false,message:err.message}); });

app.listen(PORT,()=>{
  console.log(`\n  ████  VOID STORE v3\n  ▸ Site  : http://localhost:${PORT}\n  ▸ Admin : http://localhost:${PORT}/admin.html\n  ▸ UPI   : ${UPI_ID||"⚠ NOT SET"}\n`);
});
