import type { AdapterConfigFieldsProps } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";

export function NvidiaNimConfigFields(props: AdapterConfigFieldsProps) {
  return <SchemaConfigFields {...props} />;
}
