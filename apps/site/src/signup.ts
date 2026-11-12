export type Use = "solo" | "team";
export type TeamSize = "2-10" | "11-50" | "51+";

export interface Answers {
  use: Use;
  teamSize: TeamSize | null;
  note: string | null;
}

export interface Profile {
  githubLogin: string | null;
  email: string | null;
}

export interface Signup extends Profile, Answers {
  createdAt: string;
  updatedAt: string;
}

export interface Auth {
  verify(token: string): Promise<string | null>;
  profile(userId: string): Promise<Profile>;
}

export interface SignupStore {
  get(userId: string): Promise<Signup | null>;
  put(userId: string, profile: Profile, answers: Answers, now: string): Promise<Signup>;
  delete(userId: string): Promise<void>;
}
