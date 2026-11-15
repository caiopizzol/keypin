import type {
  Item,
  ItemCategory,
  ItemCreateParams,
  ItemField,
  ItemFieldType,
  ItemOverview,
  VaultOverview,
} from "@1password/sdk";

export type Field = Omit<ItemField, "fieldType"> & { fieldType: `${ItemFieldType}` };

export type FullItem = Omit<Item, "category" | "fields"> & {
  category: `${ItemCategory}`;
  fields: Field[];
};

export type CreateParams = Omit<ItemCreateParams, "category" | "fields"> & {
  category: `${ItemCategory}`;
  fields?: Field[];
};

export interface SdkClient {
  vaults: { list(): Promise<Pick<VaultOverview, "id" | "title">[]> };
  items: {
    list(vaultId: string): Promise<Pick<ItemOverview, "id" | "title" | "tags" | "updatedAt">[]>;
    get(vaultId: string, itemId: string): Promise<FullItem>;
    create(params: CreateParams): Promise<unknown>;
    put(item: FullItem): Promise<unknown>;
  };
}

export type Connect = (account: string) => Promise<SdkClient>;

type Sdk = typeof import("@1password/sdk");

export const desktopConnect: Connect = (account) =>
  sdkClient((sdk) => new sdk.DesktopAuth(account));

export const tokenClient = (token: string): Promise<SdkClient> => sdkClient(() => token);

async function sdkClient(
  auth: (sdk: Sdk) => string | InstanceType<Sdk["DesktopAuth"]>,
): Promise<SdkClient> {
  const sdk = await import("@1password/sdk");
  const client = await sdk.createClient({
    auth: auth(sdk),
    integrationName: "keypin",
    integrationVersion: "0.0.0",
  });
  const field = (f: Field): ItemField => ({ ...f, fieldType: sdk.ItemFieldType[f.fieldType] });
  return {
    vaults: { list: () => client.vaults.list() },
    items: {
      list: (vaultId) => client.items.list(vaultId),
      get: (vaultId, itemId) => client.items.get(vaultId, itemId),
      create: (params) =>
        client.items.create({
          ...params,
          category: sdk.ItemCategory[params.category],
          fields: params.fields?.map(field),
        }),
      put: (item) =>
        client.items.put({
          ...item,
          category: sdk.ItemCategory[item.category],
          fields: item.fields.map(field),
        }),
    },
  };
}
