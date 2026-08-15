// THE choke point. Every dangerous action in the system passes through
// authorize(). Nine destructive tools, one function to audit and one to test.
//
// Built in the 13:00 block. Until then it fails closed, which is the correct
// behaviour for an unimplemented gate: refuse everything.

export class NotImplemented extends Error {
  constructor(what) {
    super(`not implemented: ${what}`);
    this.name = "NotImplemented";
  }
}

/**
 * @returns {Promise<{status:'executed'|'refused'|'escalated', tier:string,
 *   authority:string, reason?:string, ledgerSeq?:number}>}
 */
export async function authorize(_action, _ctx) {
  // Fail closed. An ungoverned execution path must never exist, not even
  // transiently while the gate is being written.
  throw new NotImplemented("broker.authorize");
}
