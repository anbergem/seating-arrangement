export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: "active" | "archived";
  version: number;
  createdAt?: string;
}
