/** The signed-in staff member, with the branches they may manage. */
export interface Actor {
  staffId: number;
  role: string;
  /** The session branch. */
  branchId: number;
  /** Access to all branches (staff.is_all_branches). */
  allBranches: boolean;
}

/** A locations row in application form. */
export interface LocationRecord {
  id: number;
  branchId: number;
  name: string;
  isDefaultFulfillment: boolean;
  createdAt: Date;
}

/** One of a staff member's assigned locations (staff_locations). */
export interface StaffLocationRecord {
  locationId: number;
  locationName: string;
  branchId: number;
}

/** Rows that keep a location from being deleted, by kind. */
export interface LocationDependency {
  type: string;
  count: number;
}
