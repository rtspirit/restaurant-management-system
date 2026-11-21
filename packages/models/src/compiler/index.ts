// The model compiler. Pure functions: definitions in, SQL text out. Nothing here touches a database.
export { CompileError, objectName, quoteIdent, quoteLiteral } from "./sql.js";
export { compileExpr, type FieldResolver } from "./expr.js";
export {
  type Column,
  type CompileContext,
  type CompileTarget,
  type ModelSource,
  CUSTOM_KEY_PREFIX,
  hasSoftDelete,
  indexName,
  ruleConstraintName,
  systemColumnsFor,
  tableColumns,
  targetsFor,
  uniqueConstraintName,
} from "./shape.js";
export { FISCAL_PERIOD } from "./rules.js";
export { type CompiledChange, type CompiledModel, type PreCheck, compileChange, compileDiscard, compileDrop, compileModel, modelDependencies } from "./model.js";
export { checkQuery, checkStatement } from "./guard.js";
