export type Role = 'admin' | 'storekeeper' | 'technician' | 'auditor';
export type ToolStatus = 'available' | 'checked_out' | 'quarantined' | 'retired';
export type CalibrationState = 'not_required' | 'ok' | 'due_soon' | 'expired';
export type ReturnCondition = 'ok' | 'damaged' | 'needs_calibration';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface Tool {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  status: ToolStatus;
  homeLocationId: string;
  homeLocationName: string;
  requiresCalibration: boolean;
  calibrationIntervalDays: number | null;
  lastCalibratedOn: string | null;
  calibrationDueOn: string | null;
  calibrationState: CalibrationState;
  holderId: string | null;
  holderName: string | null;
  dueBackAt: string | null;
  overdue: boolean;
}

export interface ToolDetail extends Tool {
  openCheckout: {
    id: string;
    holderId: string;
    holderName: string;
    checkedOutAt: string;
    dueBackAt: string;
    overdue: boolean;
  } | null;
  calibrations: {
    id: string;
    calibratedOn: string;
    dueOn: string;
    certificateRef: string | null;
    performedBy: string;
  }[];
}

export interface Checkout {
  id: string;
  toolId: string;
  assetTag: string;
  toolName: string;
  holderId: string;
  holderName: string;
  checkedOutAt: string;
  dueBackAt: string;
  returnedAt: string | null;
  conditionOnReturn: ReturnCondition | null;
  notes: string | null;
  overdue: boolean;
}

export interface Location {
  id: string;
  name: string;
  kind: 'crib' | 'bay' | 'line' | 'external';
}

export interface Dashboard {
  counts: {
    total: number;
    available: number;
    checkedOut: number;
    quarantined: number;
    calibrationExpired: number;
    calibrationDueSoon: number;
    overdue: number;
  };
  myCheckouts: {
    id: string;
    toolId: string;
    assetTag: string;
    toolName: string;
    checkedOutAt: string;
    dueBackAt: string;
    overdue: boolean;
  }[];
  dueSoonDays: number;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
}

export interface Holder {
  id: string;
  displayName: string;
  role: Role;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt?: string;
  inviteUrl?: string;
}
