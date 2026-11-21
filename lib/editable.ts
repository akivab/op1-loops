/** Edits are saved to data/loops.json in dev, or in production when OP1_EDIT=1. */
export const editable = () => process.env.NODE_ENV !== "production" || process.env.OP1_EDIT === "1";
