import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RootStackParamList } from './src/navigation';
import { ComposeScreen } from './src/screens/ComposeScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ConversationScreen } from './src/screens/ConversationScreen';
import { DraftsScreen } from './src/screens/DraftsScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { KeysScreen } from './src/screens/KeysScreen';
import { MessageScreen } from './src/screens/MessageScreen';
import { ScheduledScreen } from './src/screens/ScheduledScreen';
import { SimpleComposeScreen } from './src/screens/simple/SimpleComposeScreen';
import { SimpleInboxScreen } from './src/screens/simple/SimpleInboxScreen';
import { SimpleKeysScreen } from './src/screens/simple/SimpleKeysScreen';
import { SimpleMessageScreen } from './src/screens/simple/SimpleMessageScreen';
import { AppProvider, useApp } from './src/state/AppState';
import { loadUiMode, saveUiMode, UiMode } from './src/store/uiModeStore';
import { color, font } from './src/theme';
import { AuroraBackground } from './src/ui/AuroraBackground';
import { SecondaryButton } from './src/ui/primitives';

const Stack = createNativeStackNavigator<RootStackParamList>();

// Transparent surfaces everywhere so the aurora shows through every screen.
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: 'transparent',
    card: 'transparent',
    border: color.lineSoft,
    text: color.ink,
    primary: color.brass,
    notification: color.coral,
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: 'rgba(10,13,17,0.55)' },
  headerTintColor: color.ink,
  headerTitleStyle: { fontFamily: font.display, fontSize: 16 },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: 'transparent' },
} as const;

/**
 * The four-screen UI (docs/simple-ui-plan.md). Sign in, read, read encrypted,
 * send — encrypted or, by explicit choice, not.
 */
function SimpleStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="SimpleInbox" component={SimpleInboxScreen} options={{ headerShown: false }} />
      <Stack.Screen name="SimpleMessage" component={SimpleMessageScreen} options={{ title: '' }} />
      <Stack.Screen
        name="SimpleCompose"
        component={SimpleComposeScreen}
        options={{ title: 'New message', presentation: 'modal' }}
        initialParams={{}}
      />
      <Stack.Screen name="SimpleKeys" component={SimpleKeysScreen} options={{ title: 'Keys' }} />
    </Stack.Navigator>
  );
}

/** The original eight-screen UI, unchanged and still reachable. */
function FullStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="Inbox" component={InboxScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Conversation" component={ConversationScreen} options={{ title: 'Conversation' }} />
      <Stack.Screen name="Message" component={MessageScreen} options={{ title: '' }} />
      <Stack.Screen
        name="Compose"
        component={ComposeScreen}
        options={{ title: 'New message', presentation: 'modal' }}
        initialParams={{}}
      />
      <Stack.Screen name="Drafts" component={DraftsScreen} options={{ title: 'Drafts' }} />
      <Stack.Screen name="Scheduled" component={ScheduledScreen} options={{ title: 'Scheduled' }} />
      <Stack.Screen name="Keys" component={KeysScreen} options={{ title: 'Keys' }} />
    </Stack.Navigator>
  );
}

function Root() {
  const { booting, session } = useApp();
  const [uiMode, setUiMode] = useState<UiMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadUiMode().then((m) => {
      if (!cancelled) setUiMode(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    const next: UiMode = uiMode === 'simple' ? 'full' : 'simple';
    setUiMode(next);
    await saveUiMode(next);
  }

  if (booting || uiMode === null) {
    return (
      <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
        <ActivityIndicator color={color.brass} />
      </View>
    );
  }

  if (!session) return <ConnectScreen />;

  return (
    <View style={{ flex: 1 }}>
      <NavigationContainer theme={navTheme}>
        {uiMode === 'simple' ? <SimpleStack /> : <FullStack />}
      </NavigationContainer>
      {/* Neither UI is a trapdoor: the other one is always one tap away. */}
      <View style={{ alignItems: 'center', paddingBottom: 6 }}>
        <SecondaryButton
          title={uiMode === 'simple' ? 'Switch to full UI' : 'Switch to simple UI'}
          onPress={() => void toggle()}
        />
      </View>
    </View>
  );
}

export default function App() {
  // Paint the web page canvas dark so any gutter/overscroll never flashes white.
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.style.backgroundColor = color.ground;
      document.body.style.backgroundColor = color.ground;
    }
  }, []);

  // Gate on the custom faces so text never flashes in a fallback and reflows.
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppProvider>
        <AuroraBackground>
          {fontsLoaded ? (
            <Root />
          ) : (
            <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
              <ActivityIndicator color={color.brass} />
            </View>
          )}
        </AuroraBackground>
      </AppProvider>
    </SafeAreaProvider>
  );
}
