import {SavedSourceGenerations} from '../dist/services/source-update/generation.js';
import {ACCEPTED} from '../dist/contracts/saved-generation.js';
import {join} from 'node:path';

/** Explicit opt-in composition seam. Arguments are operator configuration, never request input.
 * No network, environment discovery, DB, activation default or automatic pointer write.
 * Attach sourceGenerations to the existing dependencies and close it after the application.
 */
export async function openSavedGeneration({root,holdersRoot,stakesRoot}) {
  const reader=await SavedSourceGenerations.activate({root,holdersRoot,stakesRoot});
  try {await reader.admit(join(root,ACCEPTED.generation));await reader.loadSelection();return reader;}
  catch(error){await reader.close();throw error;}
}
