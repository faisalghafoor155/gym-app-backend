/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { authed } from "../types.js";
import { getMyProfile, updateMyProfile } from "../controllers/meController.js";
import { updateMyProfileSchema } from "../schemas.js";

const router = Router();

// Deliberately not role-gated: any signed-in account may read or update its own
// record, and the controller scopes everything to the session's memberId.
router.use(auth);
router.get("/", authed(getMyProfile));
router.put("/", validate(updateMyProfileSchema), authed(updateMyProfile));

export default router;
