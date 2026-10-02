import type { ListedModel } from "../../gateway/types";
import { workerdFetch } from "../../workerd-fetch";

/** The models.dev catalog: every provider's models by id, with names and release days. */
const MODELS_DEV_CATALOG = "https://models.dev/api.json";

/** An id that pins a dated snapshot of a model the catalog also lists by its alias. */
const DATED_SNAPSHOT = /-\d{8}$/;

/** The marker models.dev puts on an alias name. The alias id already says it. */
const ALIAS_MARKER = /\s*\(latest\)$/;

type CatalogModel = { id: string; name: string; release_date: string };
type Catalog = { anthropic?: { models?: Record<string, CatalogModel> } };

/** Anthropic's models by their plain API ids, newest first, from the models.dev catalog. */
export async function anthropicModels(fetcher?: typeof fetch): Promise<ListedModel[]> {
  const response = await workerdFetch(fetcher)(MODELS_DEV_CATALOG);
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  const catalog: Catalog = await response.json();
  return Object.values(catalog.anthropic?.models ?? {})
    .filter((model) => !DATED_SNAPSHOT.test(model.id))
    .map((model) => ({
      id: model.id,
      name: model.name.replace(ALIAS_MARKER, ""),
      released: model.release_date,
    }))
    .toSorted((left, right) => right.released.localeCompare(left.released));
}
