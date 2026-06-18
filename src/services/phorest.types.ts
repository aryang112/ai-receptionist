// describes what a Phorest adapter must provide

// A salon service (e.g., Eyebrow Threading)
export type Service = {
  id: string;            // unique ID for the service
  name: string;          // name the client sees
  price: number;         // cost in dollars (or local currency)
  durationMin: number;   // duration in minutes
};

// A slot is a date+time in ISO format (e.g., "2025-10-01T14:20:00")
export type SlotISO = string;

export type CustomerResult = {
  clientId: string;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
};

export type AppointmentSummary = {
  appointmentId: string;
  serviceName: string;
  date: string;         // "YYYY-MM-DD" in salon timezone
  timeDisplay: string;  // "2:00 PM" human-readable
  startTimeRaw: string; // "HH:mm:ss" UTC — for internal logic
  endTimeRaw: string;   // "HH:mm:ss" UTC — for internal logic
};

// The full contract for any Phorest implementation (mock or real)
export interface PhorestPort {
  // Get the list of all services (threading, waxing, etc.)
  listServices(): Promise<Service[]>;

  // Ask for availability of one service on a given date
  getAvailability(serviceId: string, date: string): Promise<SlotISO[]>;

  // Create a new appointment for a customer
  createAppointment(
    serviceId: string,
    startIso: string,
    customer: { name: string; phone?: string; email?: string }
  ): Promise<{ appointmentId: string }>;

  // Update an existing appointment
  updateAppointment(
    appointmentId: string,
    newStartIso: string
  ): Promise<{ appointmentId: string }>;

  // Cancel an appointment
  cancelAppointment(
    appointmentId: string
  ): Promise<{ appointmentId: string; cancelled: true }>;

  // Look up a customer by phone number (10-digit, no leading 1)
  lookupCustomerByPhone(phone: string): Promise<CustomerResult | null>;

  // Look up customers by name
  lookupCustomerByName(firstName: string, lastName: string): Promise<CustomerResult[]>;

  // List upcoming appointments for a client
  listAppointments(clientId: string, fromDate?: string): Promise<AppointmentSummary[]>;

  // Add a note to an appointment (best-effort)
  addAppointmentNote(appointmentId: string, note: string): Promise<void>;

  // Get all of today's appointments (for running-late squeeze check)
  getTodayAppointments(): Promise<AppointmentSummary[]>;

  // Preload client phone index for fast lookups (optional, no-op in mock)
  preloadClients?(): Promise<void>;
}
