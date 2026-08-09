export function packageRecordFromPackOutput(packOutput, packageName) {
  const packageRecord = Array.isArray(packOutput)
    ? packOutput[0]
    : packOutput?.[packageName];

  if (typeof packageRecord?.filename !== "string") {
    throw new Error("npm pack did not report a tarball filename");
  }

  return packageRecord;
}
