import { Router, type IRouter } from "express";
import healthRouter from "./health";
import trueRevisionRouter from "./trueRevision";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/tr", trueRevisionRouter);

export default router;
