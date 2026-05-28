export interface Customer {
  id: string
  companyName: string
  customerName: string
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

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理者',
  manager: 'マネージャー',
  staff: 'スタッフ',
}
