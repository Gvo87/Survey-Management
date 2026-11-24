/**
 * Phase 3B: the respondent app's buttons and messages in the survey's language. The API sends them with
 * the translated survey; English is the default (and the builder preview's language).
 */
import { createContext, useContext } from 'react';
import { UI_STRINGS, type UiStrings } from '@survey/core';

export const UiContext = createContext<UiStrings>(UI_STRINGS);
export const useUi = () => useContext(UiContext);
