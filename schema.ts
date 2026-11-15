import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";

export const bookings = pgTable("bookings", {
  id: serial().primaryKey(),
  date: text().notNull(), // YYYY-MM-DD
  startTime: text("start_time").notNull(), // HH:MM (24h)
  minutes: integer().notNull(),
  services: text().notNull(),
  vehicle: text().notNull().default(""),
  notes: text().notNull().default(""),
  name: text().notNull(),
  phone: text().notNull(),
  email: text().notNull().default(""),
  // Secret token used in the customer's cancel link.
  cancelToken: text("cancel_token").unique(),
  cancelledAt: timestamp("cancelled_at"),
  cancelReason: text("cancel_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One row per 30-minute slot a booking occupies; the unique constraint prevents double bookings.
export const bookingSlots = pgTable(
  "booking_slots",
  {
    id: serial().primaryKey(),
    bookingId: integer("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
    date: text().notNull(),
    slot: text().notNull(),
  },
  (t) => [unique("booking_slots_date_slot_unique").on(t.date, t.slot)],
);
