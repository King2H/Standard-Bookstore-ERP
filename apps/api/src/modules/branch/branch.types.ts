/** The signed-in staff member, with the branches they may manage. */
export interface Actor {
  staffId: number;
  role: string;
  /** The session branch. */
  branchId: number;
  /** Access to all branches (staff.is_all_branches). */
  allBranches: boolean;
}

/** A branches row in application form. */
export interface BranchRecord {
  id: number;
  name: string;
  address: string;
  contactInfo: Record<string, string>;
  operatingHours: Record<string, string>;
  isActive: boolean;
  createdAt: Date;
}

export interface NewBranch {
  name: string;
  address: string;
  contactInfo: Record<string, string>;
  operatingHours: Record<string, string>;
}

export type BranchChanges = Partial<NewBranch>;

/** Records that keep a branch from being deleted, by kind. */
export interface BranchDependency {
  type: string;
  count: number;
}
