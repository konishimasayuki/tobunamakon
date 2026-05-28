export interface Customer {
  id: string
  customerCode: string
  companyName: string
  companyNameKana: string
  phone: string
  address: string
  contactPerson: string
  memo: string
  createdAt: string
  updatedAt: string
}

export interface User {
  id: string
  username: string
  displayName: string
  passwordHash: string
  role: 'admin' | 'manager' | 'staff'
  createdAt: string
}

export type UserRole = 'admin' | 'manager' | 'staff'
