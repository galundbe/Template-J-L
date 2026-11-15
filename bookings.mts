import type { Config } from "@netlify/functions";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { db } from "../../db/index.js";
import { bookings, bookingSlots } from "../../db/schema.js";

// Keep in step with CONFIG in index.html.
const SLOT_MINUTES = 30;
const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 240;
const HOURS: Record<number, [string, string] | null> = {
  0: null,
  1: ["08:00", "17:00"],
  2: ["08:00", "17:00"],
  3: ["08:00", "17:00"],
  4: ["08:00", "17:00"],
  5: null,
  6: null,
};
const SERVICE_MINUTES: Record<string, number> = {
  "NYS inspection": 30,
  "Oil change / maintenance": 30,
  "Tire repair": 30,
  "Engine diagnostic / check engine light": 60,
  "Fuel system diagnostic": 60,
  "Exhaust repair": 90,
  Towing: 30,
  "Car wash": 30,
  "Something else": 60,
};

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const key24 = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const weekday = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const jobMinutes = (services: string[]) => {
  if (!services.length) return DEFAULT_MINUTES;
  const total = services.reduce((t, s) => t + (SERVICE_MINUTES[s] ?? DEFAULT_MINUTES), 0);
  return Math.min(Math.ceil(total / SLOT_MINUTES) * SLOT_MINUTES, MAX_MINUTES);
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SHOP_NAME = "J & L Auto Services";
const SHOP_PHONE = "315-793-0835";
const SHOP_ADDRESS = "1100 Champlin Ave, Utica, NY 13502";
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const tableHtml = (rows: [string, string][]) =>
  `<table cellpadding="6" style="border-collapse:collapse">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="font-weight:bold;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v).replace(/\n/g, "<br>")}</td></tr>`,
    )
    .join("")}</table>`;

function getMailer() {
  const user = Netlify.env.get("GMAIL_USER");
  const pass = Netlify.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) {
    console.warn("Email not sent: GMAIL_USER or GMAIL_APP_PASSWORD is missing.");
    return null;
  }
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass: pass.replace(/\s+/g, "") },
  });
  return { user, transporter };
}

const dateLabelOf = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
};
const timeLabelOf = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
// Today's date at the shop (Utica, NY), as YYYY-MM-DD.
const shopToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const btnStyle = (bg: string) =>
  `display:inline-block;background:${bg};color:#ffffff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:4px`;
const buttonHtml = (href: string, label: string, bg = "#D9232A") =>
  `<p><a href="${escapeHtml(href)}" style="${btnStyle(bg)}">${escapeHtml(label)}</a></p>`;
const manageButtonsHtml = (modifyUrl: string, cancelUrl: string) =>
  `<p>Need a different day or time, or want to change the services? Can't make it at all? You can do it online:</p><p><a href="${escapeHtml(modifyUrl)}" style="${btnStyle("#1A1A1A")};margin:0 8px 8px 0">Modify my appointment</a><a href="${escapeHtml(cancelUrl)}" style="${btnStyle("#D9232A")};margin:0 8px 8px 0">Cancel my appointment</a></p>`;
const manageText = (modifyUrl: string, cancelUrl: string) =>
  `Need to change it? Modify your appointment here: ${modifyUrl}\nCan't make it? Cancel your appointment here: ${cancelUrl}`;
const manageUrls = (origin: string, token: string) => ({
  modifyUrl: `${origin}/modify?token=${token}`,
  cancelUrl: `${origin}/cancel?token=${token}`,
});
const fmtDur = (m: number) =>
  [Math.floor(m / 60) ? `${Math.floor(m / 60)} hr` : "", m % 60 ? `${m % 60} min` : ""].filter(Boolean).join(" ");
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

async function sendCustomerEmail(b: Record<string, string>, kind: "new" | "updated" = "new") {
  if (!b.email || !isEmail(b.email)) return;
  const mailer = getMailer();
  if (!mailer) return;
  const { user, transporter } = mailer;
  const first = b.name.split(" ")[0];
  const rows: [string, string][] = [
    ["Day", b.dateLabel],
    ["Time", b.timeLabel],
    ["Estimated length", b.duration],
    ["Services", b.services],
    ["Vehicle", b.vehicle],
    ["Where", SHOP_ADDRESS],
  ];
  const intro =
    kind === "new"
      ? `Hi ${first}, thanks for booking with ${SHOP_NAME}. Your appointment is confirmed and your time is reserved for you.`
      : `Hi ${first}, your appointment with ${SHOP_NAME} has been updated. Here are your new details. Your previous time is no longer reserved.`;
  const outro = `${b.phone ? `We may give you a call at ${b.phone} if we have any questions about your car. ` : ""}Questions? Call us at ${SHOP_PHONE}.`;
  const hasLinks = !!(b.cancelUrl && b.modifyUrl);
  const linksText = hasLinks ? manageText(b.modifyUrl, b.cancelUrl) : "";
  await transporter.sendMail({
    from: `"${SHOP_NAME}" <${user}>`,
    to: b.email,
    replyTo: Netlify.env.get("OWNER_EMAIL") || user,
    subject: `Appointment ${kind === "new" ? "confirmed" : "updated"}: ${b.dateLabel} at ${b.timeLabel} | ${SHOP_NAME}`,
    text: `${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${outro}\n\n${linksText ? `${linksText}\n\n` : ""}${SHOP_NAME}\n${SHOP_ADDRESS}\n${SHOP_PHONE}`,
    html: `<p>${escapeHtml(intro)}</p>${tableHtml(rows)}<p>${escapeHtml(outro)}</p>${hasLinks ? manageButtonsHtml(b.modifyUrl, b.cancelUrl) : ""}<p><strong>${escapeHtml(SHOP_NAME)}</strong><br>${escapeHtml(SHOP_ADDRESS)}<br><a href="tel:+13157930835">${SHOP_PHONE}</a></p>`,
  });
}

async function sendOwnerEmail(b: Record<string, string>) {
  const mailer = getMailer();
  if (!mailer) return;
  const { user, transporter } = mailer;
  const to = Netlify.env.get("OWNER_EMAIL") || user;
  const rows: [string, string][] = [
    ["Name", b.name],
    ["Email", b.email],
    ["Phone", b.phone || "(not given)"],
    ["Day", b.dateLabel],
    ["Time", b.timeLabel],
    ["Estimated length", b.duration],
    ["Services", b.services],
    ["Vehicle", b.vehicle],
    ["Notes", b.notes],
  ];
  const next = "A confirmation email was sent to the customer.";
  await transporter.sendMail({
    from: `"Website bookings" <${user}>`,
    to,
    replyTo: b.email || undefined,
    subject: `New appointment request: ${b.name}, ${b.dateLabel} at ${b.timeLabel}`,
    text: `New appointment request from the website.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${next}`,
    html: `<p>New appointment request from the website.</p>${tableHtml(rows)}<p>${escapeHtml(next)}</p>`,
  });
}

async function sendCancelEmails(b: Record<string, string>, bookUrl: string) {
  const mailer = getMailer();
  if (!mailer) return;
  const { user, transporter } = mailer;
  const owner = Netlify.env.get("OWNER_EMAIL") || user;
  const rows: [string, string][] = [
    ["Day", b.dateLabel],
    ["Time", b.timeLabel],
    ["Services", b.services],
    ["Vehicle", b.vehicle],
  ];
  const first = b.name.split(" ")[0];
  const intro = `Hi ${first}, your appointment with ${SHOP_NAME} has been cancelled. The time below is no longer reserved for you.`;
  const outro = `Want to come in another time? Book again at ${bookUrl} or call us at ${SHOP_PHONE}.`;
  const ownerRows: [string, string][] = [
    ["Name", b.name],
    ["Email", b.email],
    ["Phone", b.phone || "(not given)"],
    ...rows,
    ["Reason", b.reason || "(not given)"],
  ];
  const ownerNote = "The time slot is open again on the website.";
  const sends = [
    transporter.sendMail({
      from: `"Website bookings" <${user}>`,
      to: owner,
      replyTo: b.email || undefined,
      subject: `Appointment cancelled: ${b.name}, ${b.dateLabel} at ${b.timeLabel}`,
      text: `A customer cancelled their appointment.\n\n${ownerRows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${ownerNote}`,
      html: `<p>A customer cancelled their appointment.</p>${tableHtml(ownerRows)}<p>${escapeHtml(ownerNote)}</p>`,
    }),
  ];
  if (b.email && isEmail(b.email)) {
    sends.push(
      transporter.sendMail({
        from: `"${SHOP_NAME}" <${user}>`,
        to: b.email,
        replyTo: owner,
        subject: `Appointment cancelled: ${b.dateLabel} at ${b.timeLabel} | ${SHOP_NAME}`,
        text: `${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${outro}\n\n${SHOP_NAME}\n${SHOP_ADDRESS}\n${SHOP_PHONE}`,
        html: `<p>${escapeHtml(intro)}</p>${tableHtml(rows)}<p>Want to come in another time? Book again online or call us at ${escapeHtml(SHOP_PHONE)}.</p>${buttonHtml(bookUrl, "Book a new time")}<p><strong>${escapeHtml(SHOP_NAME)}</strong><br>${escapeHtml(SHOP_ADDRESS)}<br><a href="tel:+13157930835">${SHOP_PHONE}</a></p>`,
      }),
    );
  }
  const results = await Promise.allSettled(sends);
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`Failed to send ${i ? "customer" : "shop"} cancellation email`, r.reason);
  });
}

async function sendOwnerChangeEmail(before: Record<string, string>, after: Record<string, string>, b: Record<string, string>) {
  const mailer = getMailer();
  if (!mailer) return;
  const { user, transporter } = mailer;
  const to = Netlify.env.get("OWNER_EMAIL") || user;
  const fields: [string, string][] = [
    ["Day", "dateLabel"],
    ["Time", "timeLabel"],
    ["Estimated length", "duration"],
    ["Services", "services"],
  ];
  const rows: [string, string][] = [
    ["Name", b.name],
    ["Email", b.email],
    ["Phone", b.phone || "(not given)"],
    ["Vehicle", b.vehicle],
    ...fields.map(([label, k]): [string, string] =>
      before[k] === after[k] ? [label, after[k]] : [label, `${after[k]}  (was: ${before[k]})`],
    ),
    ["Note from customer", b.message || "(none)"],
  ];
  const next = "The old time is open again on the website and the new time is reserved. The customer was emailed the updated details.";
  await transporter.sendMail({
    from: `"Website bookings" <${user}>`,
    to,
    replyTo: b.email || undefined,
    subject: `Appointment changed: ${b.name}, now ${after.dateLabel} at ${after.timeLabel}`,
    text: `A customer changed their appointment.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${next}`,
    html: `<p>A customer changed their appointment.</p>${tableHtml(rows)}<p>${escapeHtml(next)}</p>`,
  });
}

async function handleModify(req: Request) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const token = body.token, date = body.dateISO, start = body.timeKey;
  const services = str(body.services, 1000).split(",").map((s) => s.trim()).filter(Boolean);
  const message = str(body.message, 1000);
  if (!isToken(token)) return Response.json({ error: "Invalid link" }, { status: 400 });
  if (!isDate(date) || !isTime(start) || !services.length) {
    return Response.json({ error: "Please pick a day, a time and at least one service." }, { status: 400 });
  }
  const [b] = await db.select().from(bookings).where(eq(bookings.cancelToken, token));
  if (!b) return Response.json({ error: "Appointment not found" }, { status: 404 });
  if (b.cancelledAt) return Response.json({ error: "This appointment was cancelled, so it can't be changed." }, { status: 409 });
  const today = shopToday();
  if (b.date < today) return Response.json({ error: "This appointment has already passed." }, { status: 400 });
  // Same rule as the booking form: from tomorrow up to 60 days out.
  if (date <= today || date > addDays(today, 60)) {
    return Response.json({ error: "Please pick a day between tomorrow and 60 days from now." }, { status: 400 });
  }

  const hours = HOURS[weekday(date)];
  const minutes = jobMinutes(services);
  const startMin = toMin(start);
  if (!hours || startMin < toMin(hours[0]) || startMin + minutes > toMin(hours[1]) || startMin % SLOT_MINUTES) {
    return Response.json({ error: "That time is outside opening hours." }, { status: 400 });
  }
  const newSlots = Array.from({ length: minutes / SLOT_MINUTES }, (_, i) => key24(startMin + i * SLOT_MINUTES));

  const owned = await db
    .select({ id: bookingSlots.id, date: bookingSlots.date, slot: bookingSlots.slot })
    .from(bookingSlots)
    .where(eq(bookingSlots.bookingId, b.id));
  const ownedKey = new Set(owned.filter((o) => o.date === date).map((o) => o.slot));
  const toAdd = newSlots.filter((s) => !ownedKey.has(s));
  const keep = new Set(newSlots);
  const toFree = owned.filter((o) => o.date !== date || !keep.has(o.slot)).map((o) => o.id);

  // Reserve the new slots first: the unique (date, slot) constraint makes this all-or-nothing,
  // so if the new time is taken the customer keeps their current appointment untouched.
  if (toAdd.length) {
    try {
      await db.insert(bookingSlots).values(toAdd.map((slot) => ({ bookingId: b.id, date, slot })));
    } catch (err) {
      console.warn("Slot conflict while modifying booking", err);
      return Response.json({ error: "Sorry, that time was just booked by someone else. Please pick another." }, { status: 409 });
    }
  }
  if (toFree.length) await db.delete(bookingSlots).where(inArray(bookingSlots.id, toFree));

  const [updated] = await db
    .update(bookings)
    .set({ date, startTime: start, minutes, services: services.join(", ") })
    .where(eq(bookings.id, b.id))
    .returning();

  const view = (r: typeof b) => ({
    dateLabel: dateLabelOf(r.date),
    timeLabel: timeLabelOf(r.startTime),
    duration: fmtDur(r.minutes),
    services: r.services,
  });
  const before = view(b), after = view(updated);
  const details = {
    name: updated.name,
    email: updated.email,
    phone: updated.phone,
    vehicle: updated.vehicle,
    ...after,
    ...manageUrls(url.origin, token),
  };
  const [owner, customer] = await Promise.allSettled([
    sendOwnerChangeEmail(before, after, { ...details, message }),
    sendCustomerEmail(details, "updated"),
  ]);
  if (owner.status === "rejected") console.error("Failed to send shop change email", owner.reason);
  if (customer.status === "rejected") console.error("Failed to send customer change email", customer.reason);

  return Response.json({ ok: true, ...after });
}

const isToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(v);

async function handleCancel(req: Request) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const token = url.searchParams.get("token");
    if (!isToken(token)) return Response.json({ error: "Invalid link" }, { status: 400 });
    const [b] = await db.select().from(bookings).where(eq(bookings.cancelToken, token));
    if (!b) return Response.json({ error: "Appointment not found" }, { status: 404 });
    return Response.json(
      {
        name: b.name.split(" ")[0],
        dateISO: b.date,
        timeKey: b.startTime,
        duration: fmtDur(b.minutes),
        dateLabel: dateLabelOf(b.date),
        timeLabel: timeLabelOf(b.startTime),
        services: b.services,
        vehicle: b.vehicle,
        cancelled: !!b.cancelledAt,
        past: b.date < shopToday(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const token = body.token;
  if (!isToken(token)) return Response.json({ error: "Invalid link" }, { status: 400 });
  const [existing] = await db.select().from(bookings).where(eq(bookings.cancelToken, token));
  if (!existing) return Response.json({ error: "Appointment not found" }, { status: 404 });
  if (existing.cancelledAt) return Response.json({ error: "This appointment was already cancelled" }, { status: 409 });
  if (existing.date < shopToday()) {
    return Response.json({ error: "This appointment has already passed" }, { status: 400 });
  }

  const reason = str(body.reason, 1000);
  // Only one request can flip cancelled_at, so emails go out once even on double clicks.
  const [b] = await db
    .update(bookings)
    .set({ cancelledAt: new Date(), cancelReason: reason || null })
    .where(and(eq(bookings.id, existing.id), isNull(bookings.cancelledAt)))
    .returning();
  if (!b) return Response.json({ error: "This appointment was already cancelled" }, { status: 409 });
  // Free the time so it can be booked again.
  await db.delete(bookingSlots).where(eq(bookingSlots.bookingId, b.id));

  await sendCancelEmails(
    {
      name: b.name,
      email: b.email,
      phone: b.phone,
      dateLabel: dateLabelOf(b.date),
      timeLabel: timeLabelOf(b.startTime),
      services: b.services,
      vehicle: b.vehicle,
      reason,
    },
    `${url.origin}/#/book`,
  );
  return Response.json({ ok: true });
}

export default async (req: Request) => {
  const path = new URL(req.url).pathname.replace(/\/$/, "");
  if (path === "/api/bookings/cancel") return handleCancel(req);
  if (path === "/api/bookings/modify") return handleModify(req);

  if (req.method === "GET") {
    const params = new URL(req.url).searchParams;
    const date = params.get("date"), token = params.get("token");
    if (!isDate(date)) return Response.json({ error: "Invalid date" }, { status: 400 });
    // When a customer is changing their appointment, their own current time shouldn't show as taken.
    let ownId: number | null = null;
    if (isToken(token)) {
      const [own] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.cancelToken, token));
      ownId = own?.id ?? null;
    }
    const rows = await db
      .select({ slot: bookingSlots.slot, bookingId: bookingSlots.bookingId })
      .from(bookingSlots)
      .where(eq(bookingSlots.date, date));
    return Response.json(
      { booked: rows.filter((r) => r.bookingId !== ownId).map((r) => r.slot) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const date = body.dateISO, start = body.timeKey;
  const name = str(body.name, 200), phone = str(body.phone, 50), email = str(body.email, 200);
  const vehicle = str(body.vehicle, 200), notes = str(body.notes);
  const services = str(body.services, 1000).split(",").map((s) => s.trim()).filter(Boolean);
  if (!isDate(date) || !isTime(start) || !name || !isEmail(email) || !vehicle || !notes || !services.length) {
    return Response.json({ error: "Missing or invalid fields" }, { status: 400 });
  }

  const hours = HOURS[weekday(date)];
  const minutes = jobMinutes(services);
  const startMin = toMin(start);
  if (!hours || startMin < toMin(hours[0]) || startMin + minutes > toMin(hours[1]) || startMin % SLOT_MINUTES) {
    return Response.json({ error: "That time is outside opening hours" }, { status: 400 });
  }
  const slots = Array.from({ length: minutes / SLOT_MINUTES }, (_, i) => key24(startMin + i * SLOT_MINUTES));

  const taken = await db
    .select({ slot: bookingSlots.slot })
    .from(bookingSlots)
    .where(and(eq(bookingSlots.date, date), inArray(bookingSlots.slot, slots)));
  if (taken.length) return Response.json({ error: "Time already booked" }, { status: 409 });

  const record = {
    date,
    startTime: start,
    minutes,
    services: services.join(", "),
    vehicle,
    notes,
    name,
    phone,
    email,
    cancelToken: randomBytes(24).toString("base64url"),
  };
  const [booking] = await db.insert(bookings).values(record).returning({ id: bookings.id });
  try {
    // Single multi-row insert: the unique (date, slot) constraint makes this all-or-nothing.
    await db.insert(bookingSlots).values(slots.map((slot) => ({ bookingId: booking.id, date, slot })));
  } catch (err) {
    await db.delete(bookings).where(eq(bookings.id, booking.id));
    console.warn("Slot conflict while booking", err);
    return Response.json({ error: "Time already booked" }, { status: 409 });
  }

  const details = {
    ...record,
    dateLabel: str(body.date, 100) || date,
    timeLabel: str(body.time, 20) || start,
    duration: `${minutes} min`,
    ...manageUrls(new URL(req.url).origin, record.cancelToken),
  };
  // The booking is saved either way; failures are logged so a bad mail setup shows up in the function logs.
  const [owner, customer] = await Promise.allSettled([sendOwnerEmail(details), sendCustomerEmail(details)]);
  if (owner.status === "rejected") console.error("Failed to send shop notification email", owner.reason);
  if (customer.status === "rejected") console.error("Failed to send customer confirmation email", customer.reason);

  return Response.json({ ok: true, id: booking.id }, { status: 201 });
};

export const config: Config = {
  path: ["/api/bookings", "/api/bookings/cancel", "/api/bookings/modify"],
};
