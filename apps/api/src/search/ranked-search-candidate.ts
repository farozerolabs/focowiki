export type RankedSearchFamily =
  | "exact_title"
  | "exact_path"
  | "title"
  | "body"
  | "path"
  | "metadata"
  | "typo";

export type RankedSearchCandidate = {
  sourceFileId: string;
  family: RankedSearchFamily;
  familyRank: number;
  familyScore: number;
};

export type RankedSearchFamilyCursor = {
  familyScore: number;
  sourceFileId: string;
};
